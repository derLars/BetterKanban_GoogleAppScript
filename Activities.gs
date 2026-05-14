// ============================================================
// Activities.gs -- Activity CRUD, column movement,
//                 comment operations, purge
// ============================================================

// -------------------------------------------------------
// Allowed fields for partial updates (per S4.6.5)
// -------------------------------------------------------
var ACTIVITY_ALLOWED_UPDATE_FIELDS = ['title', 'description', 'dueDate', 'assignedTo'];

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function findActivityIndex(activities, id) {
  for (var i = 0; i < activities.length; i++) {
    if (activities[i].id === id) return i;
  }
  return -1;
}

// -------------------------------------------------------
// CREATE
// -------------------------------------------------------

function createActivity(data) {
  if (!data || !data.title || data.title.trim() === '') {
    throw new Error('Title is required');
  }

  var email = Session.getActiveUser().getEmail();
  var cfg = getActiveConfig();
  var now = new Date().toISOString();
  var id = generateUUID();
  var activity = {
    id: id,
    deterministicId: computeDeterministicId(email, now, id),
    title: data.title.trim(),
    description: data.description || null,
    creatorEmail: email,
    creationDate: now,
    dueDate: data.dueDate || null,
    assignedTo: data.assignedTo || null,
    columnIndex: (data.columnIndex !== undefined) ? data.columnIndex : 0,
    columnOrder: 0,
    comments: [],
    version: 1,
    completedDate: null,
    deletedDate: null,
    lastModifiedDate: now
  };

  var activities = loadActivities();

  // Place at the top of the target column
  var columnActivities = activities.filter(function(a) {
    return a.columnIndex === activity.columnIndex && !a.deletedDate;
  });
  activity.columnOrder = columnActivities.length;

  activities.push(activity);
  saveActivities(activities);
  incrementDbVersion();
  try { purgeIfNeeded(); } catch (e) {}

  activity._creatorName = getDisplayName(activity.creatorEmail);
  activity._assigneeName = activity.assignedTo ? getDisplayName(activity.assignedTo) : null;

  return activity;
}

// -------------------------------------------------------
// READ
// -------------------------------------------------------

function getActivities(opts) {
  opts = opts || {};
  var activities = loadActivities();

  return activities.filter(function(a) {
    if (!opts.showDeleted && a.deletedDate) return false;
    if (!opts.showCompleted && a.completedDate) return false;
    return true;
  }).map(function(a) {
    a._creatorName = getDisplayName(a.creatorEmail);
    a._assigneeName = a.assignedTo ? getDisplayName(a.assignedTo) : null;
    if (a.comments) {
      // Newest first
      a.comments.sort(function(x, y) {
        return y.creationDate.localeCompare(x.creationDate);
      });
      a.comments.forEach(function(c) {
        c._authorName = getDisplayName(c.authorEmail);
      });
    }
    return a;
  });
}

function getActivity(id) {
  var activities = loadActivities();
  var idx = findActivityIndex(activities, id);
  if (idx === -1) throw new Error('Activity not found');

  var a = activities[idx];
  a._creatorName = getDisplayName(a.creatorEmail);
  a._assigneeName = a.assignedTo ? getDisplayName(a.assignedTo) : null;
  if (a.comments) {
    a.comments.sort(function(x, y) {
      return y.creationDate.localeCompare(x.creationDate);
    });
    a.comments.forEach(function(c) {
      c._authorName = getDisplayName(c.authorEmail);
    });
  }
  return a;
}

// -------------------------------------------------------
// UPDATE (partial, field-level merge)
// -------------------------------------------------------

function updateActivity(id, changes) {
  if (!changes || typeof changes !== 'object') {
    throw new Error('Changes object is required');
  }

  var activities = loadActivities();
  var idx = findActivityIndex(activities, id);
  if (idx === -1) throw new Error('Activity not found');

  var activity = activities[idx];

  // Optimistic lock
  if (changes.version !== undefined && changes.version !== activity.version) {
    throw new Error('Conflict: entity was modified');
  }

  ACTIVITY_ALLOWED_UPDATE_FIELDS.forEach(function(field) {
    if (changes[field] !== undefined) {
      activity[field] = changes[field];
    }
  });

  activity.version += 1;
  activity.lastModifiedDate = new Date().toISOString();
  activities[idx] = activity;
  saveActivities(activities);
  incrementDbVersion();
  try { purgeIfNeeded(); } catch (e) {}

  activity._creatorName = getDisplayName(activity.creatorEmail);
  activity._assigneeName = activity.assignedTo ? getDisplayName(activity.assignedTo) : null;
  return activity;
}

// -------------------------------------------------------
// COMPLETE / UNCOMPLETE
// -------------------------------------------------------

function completeActivity(id) {
  var activities = loadActivities();
  var idx = findActivityIndex(activities, id);
  if (idx === -1) throw new Error('Activity not found');

  var activity = activities[idx];
  activity.completedDate = new Date().toISOString();
  activity.version += 1;
  activity.lastModifiedDate = new Date().toISOString();

  // Move to completedColumnIndex if configured
  var cfg = getActiveConfig();
  if (cfg.kanban.completedColumnIndex !== undefined && cfg.kanban.completedColumnIndex !== null) {
    activity.columnIndex = cfg.kanban.completedColumnIndex;
    var completedCards = activities.filter(function(a) {
      return a.columnIndex === cfg.kanban.completedColumnIndex && a.id !== id && !a.deletedDate;
    });
    activity.columnOrder = completedCards.length;
  }

  activities[idx] = activity;
  saveActivities(activities);
  incrementDbVersion();
  try { purgeIfNeeded(); } catch (e) {}

  activity._creatorName = getDisplayName(activity.creatorEmail);
  activity._assigneeName = activity.assignedTo ? getDisplayName(activity.assignedTo) : null;
  return activity;
}

function uncompleteActivity(id) {
  var activities = loadActivities();
  var idx = findActivityIndex(activities, id);
  if (idx === -1) throw new Error('Activity not found');

  var activity = activities[idx];
  activity.completedDate = null;
  activity.version += 1;
  activity.lastModifiedDate = new Date().toISOString();

  // Move to first column
  activity.columnIndex = 0;
  activity.columnOrder = 0;

  activities[idx] = activity;
  saveActivities(activities);
  incrementDbVersion();
  try { purgeIfNeeded(); } catch (e) {}

  activity._creatorName = getDisplayName(activity.creatorEmail);
  activity._assigneeName = activity.assignedTo ? getDisplayName(activity.assignedTo) : null;
  return activity;
}

// -------------------------------------------------------
// DELETE / UNDELETE
// -------------------------------------------------------

function deleteActivity(id) {
  var activities = loadActivities();
  var idx = findActivityIndex(activities, id);
  if (idx === -1) throw new Error('Activity not found');

  var activity = activities[idx];
  activity.deletedDate = new Date().toISOString();
  activity.version += 1;
  activity.lastModifiedDate = new Date().toISOString();
  activities[idx] = activity;
  saveActivities(activities);
  incrementDbVersion();
  try { purgeIfNeeded(); } catch (e) {}

  activity._creatorName = getDisplayName(activity.creatorEmail);
  activity._assigneeName = activity.assignedTo ? getDisplayName(activity.assignedTo) : null;
  return activity;
}

function undeleteActivity(id) {
  var activities = loadActivities();
  var idx = findActivityIndex(activities, id);
  if (idx === -1) throw new Error('Activity not found');

  var activity = activities[idx];
  activity.deletedDate = null;
  activity.version += 1;
  activity.lastModifiedDate = new Date().toISOString();
  activities[idx] = activity;
  saveActivities(activities);
  incrementDbVersion();
  try { purgeIfNeeded(); } catch (e) {}

  activity._creatorName = getDisplayName(activity.creatorEmail);
  activity._assigneeName = activity.assignedTo ? getDisplayName(activity.assignedTo) : null;
  return activity;
}

// -------------------------------------------------------
// MOVE (Drag & Drop)
// -------------------------------------------------------

function moveActivity(id, columnIndex, newOrder, version) {
  var activities = loadActivities();
  var idx = findActivityIndex(activities, id);
  if (idx === -1) throw new Error('Activity not found');

  var activity = activities[idx];

  if (version !== undefined && version !== activity.version) {
    throw new Error('Conflict: entity was modified');
  }

  var oldColumnIndex = activity.columnIndex;
  activity.columnIndex = columnIndex;
  activity.version += 1;
  activity.lastModifiedDate = new Date().toISOString();
  activities[idx] = activity;

  // Renormalize columnOrder in target column
  var targetCards = activities.filter(function(a) {
    return a.columnIndex === columnIndex;
  }).sort(function(a, b) { return a.columnOrder - b.columnOrder; });

  // Remove the moved card from its current position in the sorted array
  // if already present, then insert at newOrder
  var filtered = [];
  for (var i = 0; i < targetCards.length; i++) {
    if (targetCards[i].id !== id) {
      filtered.push(targetCards[i]);
    }
  }
  // Splice the activity at newOrder
  var insertIdx = Math.min(newOrder, filtered.length);
  filtered.splice(insertIdx, 0, activity);

  // Renumber
  filtered.forEach(function(card, index) {
    for (var j = 0; j < activities.length; j++) {
      if (activities[j].id === card.id) {
        activities[j].columnOrder = index;
        break;
      }
    }
  });

  // Also renormalize source column if different from target
  if (oldColumnIndex !== columnIndex) {
    var sourceCards = activities.filter(function(a) {
      return a.columnIndex === oldColumnIndex;
    }).sort(function(a, b) { return a.columnOrder - b.columnOrder; });

    sourceCards.forEach(function(card, index) {
      for (var j = 0; j < activities.length; j++) {
        if (activities[j].id === card.id) {
          activities[j].columnOrder = index;
          break;
        }
      }
    });
  }

  saveActivities(activities);
  incrementDbVersion();
  try { purgeIfNeeded(); } catch (e) {}

  activity._creatorName = getDisplayName(activity.creatorEmail);
  activity._assigneeName = activity.assignedTo ? getDisplayName(activity.assignedTo) : null;
  return activity;
}

// -------------------------------------------------------
// COMMENT OPERATIONS
// -------------------------------------------------------

function addComment(activityId, text) {
  if (!text || text.trim() === '') {
    throw new Error('Comment text is required');
  }
  if (text.length > 2000) {
    throw new Error('Comment text exceeds 2000 character limit');
  }

  var activities = loadActivities();
  var idx = findActivityIndex(activities, activityId);
  if (idx === -1) throw new Error('Activity not found');

  var activity = activities[idx];
  var email = Session.getActiveUser().getEmail();

  var comment = {
    id: generateUUID(),
    authorEmail: email,
    creationDate: new Date().toISOString(),
    lastModifiedDate: null,
    text: text.trim()
  };

  // Evict oldest comment if at max
  var maxComments = getActiveConfig().database.maxCommentsPerActivity || 50;
  if (activity.comments.length >= maxComments) {
    // Remove oldest (last element since newest-first)
    activity.comments.pop();
  }

  // Prepend (newest first)
  activity.comments.unshift(comment);
  activity.version += 1;
  activity.lastModifiedDate = new Date().toISOString();
  activities[idx] = activity;
  saveActivities(activities);
  incrementDbVersion();
  try { purgeIfNeeded(); } catch (e) {}

  comment._authorName = getDisplayName(comment.authorEmail);
  activity._creatorName = getDisplayName(activity.creatorEmail);
  activity._assigneeName = activity.assignedTo ? getDisplayName(activity.assignedTo) : null;
  return activity;
}

function updateComment(activityId, commentId, newText) {
  if (!newText || newText.trim() === '') {
    throw new Error('Comment text is required');
  }
  if (newText.length > 2000) {
    throw new Error('Comment text exceeds 2000 character limit');
  }

  var activities = loadActivities();
  var idx = findActivityIndex(activities, activityId);
  if (idx === -1) throw new Error('Activity not found');

  var activity = activities[idx];
  var found = false;
  for (var i = 0; i < activity.comments.length; i++) {
    if (activity.comments[i].id === commentId) {
      activity.comments[i].text = newText.trim();
      activity.comments[i].lastModifiedDate = new Date().toISOString();
      found = true;
      break;
    }
  }
  if (!found) throw new Error('Comment not found');

  activity.version += 1;
  activity.lastModifiedDate = new Date().toISOString();
  activities[idx] = activity;
  saveActivities(activities);
  incrementDbVersion();
  try { purgeIfNeeded(); } catch (e) {}

  activity._creatorName = getDisplayName(activity.creatorEmail);
  activity._assigneeName = activity.assignedTo ? getDisplayName(activity.assignedTo) : null;
  return activity;
}

function deleteComment(activityId, commentId) {
  var activities = loadActivities();
  var idx = findActivityIndex(activities, activityId);
  if (idx === -1) throw new Error('Activity not found');

  var activity = activities[idx];
  var newComments = [];
  var found = false;
  for (var i = 0; i < activity.comments.length; i++) {
    if (activity.comments[i].id === commentId) {
      found = true;
    } else {
      newComments.push(activity.comments[i]);
    }
  }
  if (!found) throw new Error('Comment not found');

  activity.comments = newComments;
  activity.version += 1;
  activity.lastModifiedDate = new Date().toISOString();
  activities[idx] = activity;
  saveActivities(activities);
  incrementDbVersion();
  try { purgeIfNeeded(); } catch (e) {}

  activity._creatorName = getDisplayName(activity.creatorEmail);
  activity._assigneeName = activity.assignedTo ? getDisplayName(activity.assignedTo) : null;
  return activity;
}
