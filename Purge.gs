// ============================================================
// Purge.gs -- Scheduled cleanup of old tasks & activities
// -------------------------------------------------------
// Called by daily time-driven trigger AND by purgeIfNeeded()
// when Script Properties size exceeds 400 KB.
// ============================================================

// -------------------------------------------------------
// Purge Tasks
// -------------------------------------------------------

function purgeOldTasksInternal(cfg) {
  var tasks = loadTasks();
  var now = new Date();
  var retentionDays = (cfg && cfg.deletedTaskRetentionDays) || 7;
  var maxCompleted = (cfg && cfg.completedTaskMaxCount) || 100;
  var purged = 0;
  var deletedCount = 0;
  var completedCount = 0;

  var remaining = [];

  // Hard-delete soft-deleted tasks past retention period
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    if (t.deletedDate) {
      var deletedDate = new Date(t.deletedDate);
      var daysSinceDelete = (now.getTime() - deletedDate.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceDelete >= retentionDays) {
        purged++;
        continue; // Skip (hard-delete)
      }
    }
    remaining.push(t);
  }

  // Enforce max completed count
  var completed = remaining.filter(function(t) { return t.completedDate; });
  if (completed.length > maxCompleted) {
    completed.sort(function(a, b) { return a.completedDate.localeCompare(b.completedDate); });
    var toRemove = completed.length - maxCompleted;
    var removeIds = {};
    for (var j = 0; j < toRemove; j++) {
      removeIds[completed[j].id] = true;
      purged++;
    }

    var afterCompleted = [];
    for (var k = 0; k < remaining.length; k++) {
      if (!removeIds[remaining[k].id]) {
        afterCompleted.push(remaining[k]);
      }
    }
    remaining = afterCompleted;
  }

  if (remaining.length !== tasks.length) {
    saveTasks(remaining);
    return { purged: purged, deletedCount: deletedCount, completedCount: completedCount };
  }

  return { purged: 0, deletedCount: 0, completedCount: 0 };
}

// -------------------------------------------------------
// Purge Activities
// -------------------------------------------------------

function purgeOldActivitiesInternal(cfg) {
  var activities = loadActivities();
  var now = new Date();
  var retentionDays = (cfg && cfg.deletedTaskRetentionDays) || 7;
  var maxCompleted = (cfg && cfg.completedActivityMaxCount) || 100;
  var purged = 0;

  var remaining = [];

  for (var i = 0; i < activities.length; i++) {
    var a = activities[i];
    if (a.deletedDate) {
      var deletedDate = new Date(a.deletedDate);
      var daysSinceDelete = (now.getTime() - deletedDate.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceDelete >= retentionDays) {
        purged++;
        continue;
      }
    }
    remaining.push(a);
  }

  var completed = remaining.filter(function(a) { return a.completedDate; });
  if (completed.length > maxCompleted) {
    completed.sort(function(a, b) { return a.completedDate.localeCompare(b.completedDate); });
    var toRemove = completed.length - maxCompleted;
    var removeIds = {};
    for (var j = 0; j < toRemove; j++) {
      removeIds[completed[j].id] = true;
      purged++;
    }

    var afterCompleted = [];
    for (var k = 0; k < remaining.length; k++) {
      if (!removeIds[remaining[k].id]) {
        afterCompleted.push(remaining[k]);
      }
    }
    remaining = afterCompleted;
  }

  if (remaining.length !== activities.length) {
    saveActivities(remaining);
  }

  return { purged: purged };
}

// -------------------------------------------------------
// Public trigger entry points
// -------------------------------------------------------

function purgeOldTasks() {
  var cfg = getActiveConfig().database;
  var result = purgeOldTasksInternal(cfg);
  try { purgeIfNeeded(); } catch (e) {}
  return result;
}

function purgeOldActivities() {
  var cfg = getActiveConfig().database;
  var result = purgeOldActivitiesInternal(cfg);
  try { purgeIfNeeded(); } catch (e) {}
  return result;
}
