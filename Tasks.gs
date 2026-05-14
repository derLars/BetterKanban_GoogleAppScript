// ============================================================
// Tasks.gs -- Task CRUD, lifecycle operations, purge
// ============================================================

// -------------------------------------------------------
// Allowed fields for partial updates (per S4.6.5)
// -------------------------------------------------------
var TASK_ALLOWED_UPDATE_FIELDS = ['description', 'dueDate', 'assignedTo', 'visibility', 'comment'];

// -------------------------------------------------------
// Helper
// -------------------------------------------------------

function findTaskIndex(tasks, taskId) {
  for (var i = 0; i < tasks.length; i++) {
    if (tasks[i].id === taskId) return i;
  }
  return -1;
}

// -------------------------------------------------------
// Create
// -------------------------------------------------------

function createTask(data) {
  if (!data || !data.description || data.description.trim() === '') {
    throw new Error('Description is required');
  }

  var email = Session.getActiveUser().getEmail();
  var now = new Date().toISOString();
  var id = generateUUID();

  var task = {
    id: id,
    deterministicId: computeDeterministicId(email, now, id),
    description: data.description.trim(),
    creatorEmail: email,
    creationDate: now,
    dueDate: data.dueDate || null,
    assignedTo: data.assignedTo || null,
    visibility: data.visibility || 'private',
    comment: data.comment || null,
    version: 1,
    completedDate: null,
    deletedDate: null,
    lastModifiedDate: now
  };

  var tasks = loadTasks();
  tasks.push(task);
  saveTasks(tasks);
  incrementDbVersion();
  try { purgeIfNeeded(); } catch (e) {}

  // Enrich with display names
  task._creatorName = getDisplayName(task.creatorEmail);
  task._assigneeName = task.assignedTo ? getDisplayName(task.assignedTo) : null;

  return task;
}

// -------------------------------------------------------
// Read
// -------------------------------------------------------

function getTasks(opts) {
  opts = opts || {};
  var email = Session.getActiveUser().getEmail();
  var tasks = loadTasks();

  return tasks.filter(function(t) {
    if (!opts.showDeleted && t.deletedDate) return false;
    if (!opts.showCompleted && t.completedDate) return false;
    if (t.visibility === 'private' && t.creatorEmail !== email) return false;
    return true;
  }).map(function(t) {
    t._creatorName = getDisplayName(t.creatorEmail);
    t._assigneeName = t.assignedTo ? getDisplayName(t.assignedTo) : null;
    return t;
  });
}

function getTask(taskId) {
  var tasks = loadTasks();
  var idx = findTaskIndex(tasks, taskId);
  if (idx === -1) throw new Error('Task not found');
  var t = tasks[idx];
  t._creatorName = getDisplayName(t.creatorEmail);
  t._assigneeName = t.assignedTo ? getDisplayName(t.assignedTo) : null;
  return t;
}

// -------------------------------------------------------
// Update (partial, field-level merge)
// -------------------------------------------------------

function updateTask(taskId, changes) {
  if (!changes || typeof changes !== 'object') {
    throw new Error('Changes object is required');
  }

  var tasks = loadTasks();
  var idx = findTaskIndex(tasks, taskId);
  if (idx === -1) throw new Error('Task not found');

  var task = tasks[idx];

  // Optimistic lock check
  if (changes.version !== undefined && changes.version !== task.version) {
    throw new Error('Conflict: entity was modified');
  }

  var email = Session.getActiveUser().getEmail();

  // Field-level merge -- only apply allowed fields
  TASK_ALLOWED_UPDATE_FIELDS.forEach(function(field) {
    if (changes[field] !== undefined) {
      // Visibility change guard
      if (field === 'visibility') {
        if (task.creatorEmail !== email && !isAdmin(email)) {
          throw new Error('Not authorized to change visibility');
        }
      }
      task[field] = changes[field];
    }
  });

  task.version += 1;
  task.lastModifiedDate = new Date().toISOString();
  tasks[idx] = task;
  saveTasks(tasks);
  incrementDbVersion();
  try { purgeIfNeeded(); } catch (e) {}

  task._creatorName = getDisplayName(task.creatorEmail);
  task._assigneeName = task.assignedTo ? getDisplayName(task.assignedTo) : null;
  return task;
}

// -------------------------------------------------------
// Complete / Uncomplete
// -------------------------------------------------------

function completeTask(taskId) {
  var tasks = loadTasks();
  var idx = findTaskIndex(tasks, taskId);
  if (idx === -1) throw new Error('Task not found');

  var task = tasks[idx];
  task.completedDate = new Date().toISOString();
  task.version += 1;
  task.lastModifiedDate = new Date().toISOString();
  tasks[idx] = task;
  saveTasks(tasks);
  incrementDbVersion();
  try { purgeIfNeeded(); } catch (e) {}

  task._creatorName = getDisplayName(task.creatorEmail);
  task._assigneeName = task.assignedTo ? getDisplayName(task.assignedTo) : null;
  return task;
}

function uncompleteTask(taskId) {
  var tasks = loadTasks();
  var idx = findTaskIndex(tasks, taskId);
  if (idx === -1) throw new Error('Task not found');

  var task = tasks[idx];
  task.completedDate = null;
  task.version += 1;
  task.lastModifiedDate = new Date().toISOString();
  tasks[idx] = task;
  saveTasks(tasks);
  incrementDbVersion();
  try { purgeIfNeeded(); } catch (e) {}

  task._creatorName = getDisplayName(task.creatorEmail);
  task._assigneeName = task.assignedTo ? getDisplayName(task.assignedTo) : null;
  return task;
}

// -------------------------------------------------------
// Delete / Undelete
// -------------------------------------------------------

function deleteTask(taskId) {
  var tasks = loadTasks();
  var idx = findTaskIndex(tasks, taskId);
  if (idx === -1) throw new Error('Task not found');

  var task = tasks[idx];
  task.deletedDate = new Date().toISOString();
  task.version += 1;
  task.lastModifiedDate = new Date().toISOString();
  tasks[idx] = task;
  saveTasks(tasks);
  incrementDbVersion();
  try { purgeIfNeeded(); } catch (e) {}

  task._creatorName = getDisplayName(task.creatorEmail);
  task._assigneeName = task.assignedTo ? getDisplayName(task.assignedTo) : null;
  return task;
}

function undeleteTask(taskId) {
  var tasks = loadTasks();
  var idx = findTaskIndex(tasks, taskId);
  if (idx === -1) throw new Error('Task not found');

  var task = tasks[idx];
  task.deletedDate = null;
  task.version += 1;
  task.lastModifiedDate = new Date().toISOString();
  tasks[idx] = task;
  saveTasks(tasks);
  incrementDbVersion();
  try { purgeIfNeeded(); } catch (e) {}

  task._creatorName = getDisplayName(task.creatorEmail);
  task._assigneeName = task.assignedTo ? getDisplayName(task.assignedTo) : null;
  return task;
}
