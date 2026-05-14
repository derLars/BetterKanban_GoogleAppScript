// ============================================================
// Settings.gs — User settings: profile, webhook, vacations,
//               import from spreadsheet, export to spreadsheet
// ============================================================

function getCurrentUserEmail() {
  return Session.getActiveUser().getEmail();
}

// -------------------------------------------------------
// Profile
// -------------------------------------------------------

function updateProfile(displayName) {
  var email = getCurrentUserEmail();
  if (!displayName || displayName.trim() === '') {
    throw new Error('Display name is required');
  }
  return updateUserSettings(email, { displayName: displayName.trim() });
}

// -------------------------------------------------------
// Chat Webhook
// -------------------------------------------------------

function saveChatWebhook(url) {
  var email = getCurrentUserEmail();
  if (url && url.trim() !== '' && url.indexOf('https://chat.googleapis.com/') !== 0) {
    throw new Error('Invalid webhook URL');
  }
  return updateUserSettings(email, { chatWebhookUrl: url ? url.trim() : '' });
}

// -------------------------------------------------------
// Vacation Periods
// -------------------------------------------------------

function saveVacations(vacations) {
  var email = getCurrentUserEmail();

  if (!Array.isArray(vacations)) {
    throw new Error('Vacations must be an array');
  }

  for (var i = 0; i < vacations.length; i++) {
    var v = vacations[i];
    if (!v.start || !v.end) {
      throw new Error('Invalid date range');
    }
    if (v.start > v.end) {
      throw new Error('Invalid date range');
    }
  }

  return updateUserSettings(email, { vacations: vacations });
}

// -------------------------------------------------------
// Import from Spreadsheet Dump
// -------------------------------------------------------

function importFromSpreadsheet(sheetId) {
  if (!sheetId || sheetId.trim() === '') {
    throw new Error('Spreadsheet ID is required');
  }
  sheetId = sheetId.trim();

  var tasksRaw = [];
  var activitiesRaw = [];

  try {
    tasksRaw = readDumpSheet(sheetId, '_Dump_Tasks');
  } catch (e) {
    // May not exist — that's ok
  }

  try {
    activitiesRaw = readDumpSheet(sheetId, '_Dump_Activities');
  } catch (e) {
    // May not exist — that's ok
  }

  if (tasksRaw.length === 0 && activitiesRaw.length === 0) {
    throw new Error('No data found in _Dump_Tasks or _Dump_Activities sheets');
  }

  // Load current data for dedup
  var tasks = loadTasks();
  var activities = loadActivities();

  var existingTaskIds = {};
  tasks.forEach(function(t) {
    if (t.deterministicId) existingTaskIds[t.deterministicId] = true;
  });
  var existingActivityIds = {};
  activities.forEach(function(a) {
    if (a.deterministicId) existingActivityIds[a.deterministicId] = true;
  });

  var tasksImported = 0;
  var tasksSkipped = 0;
  var activityImported = 0;
  var activitySkipped = 0;
  var errors = 0;

  var cfg = getActiveConfig();
  var columns = cfg.kanban.columns || [];

  // Import tasks
  tasksRaw.forEach(function(row) {
    var detId = row.deterministicId || row.hashId;
    if (!detId) { errors++; return; }

    if (existingTaskIds[detId]) {
      tasksSkipped++;
      return;
    }

    tasks.push({
      id: generateUUID(),
      deterministicId: detId,
      description: row.description || '',
      creatorEmail: row.creatorEmail || '_deleted_',
      creationDate: row.creationDate || new Date().toISOString(),
      dueDate: row.dueDate || null,
      assignedTo: row.assignedTo || null,
      visibility: row.visibility || 'public',
      comment: row.comment || null,
      version: 1,
      completedDate: row.completedDate || null,
      deletedDate: row.deletedDate || null,
      lastModifiedDate: new Date().toISOString()
    });
    tasksImported++;
  });

  // Import activities
  activitiesRaw.forEach(function(row) {
    var detId = row.deterministicId || row.hashId;
    if (!detId) { errors++; return; }

    if (existingActivityIds[detId]) {
      activitySkipped++;
      return;
    }

    // Determine target column by columnNumber (1-indexed)
    var targetColumnId = (columns.length > 0) ? columns[0].name : 'Activities';
    var colNumber = parseInt(row.columnNumber, 10);
    if (!isNaN(colNumber) && colNumber >= 1 && colNumber <= columns.length) {
      targetColumnId = columns[colNumber - 1].name;
    }

    var comments = [];
    if (row.comments) {
      try { comments = JSON.parse(row.comments); } catch (e) {}
    }

    activities.push({
      id: generateUUID(),
      deterministicId: detId,
      title: row.title || '',
      description: row.description || null,
      creatorEmail: row.creatorEmail || '_deleted_',
      creationDate: row.creationDate || new Date().toISOString(),
      dueDate: row.dueDate || null,
      assignedTo: row.assignedTo || null,
      columnId: targetColumnId,
      columnOrder: parseInt(row.columnOrder, 10) || 0,
      comments: comments,
      version: 1,
      completedDate: row.completedDate || null,
      deletedDate: row.deletedDate || null,
      lastModifiedDate: new Date().toISOString()
    });
    activityImported++;
  });

  saveTasks(tasks);
  saveActivities(activities);

  incrementDbVersion();
  try {
    CacheService.getScriptCache().remove('db_tasks');
    CacheService.getScriptCache().remove('db_activities');
  } catch (e) {}

  return {
    tasksImported: tasksImported,
    tasksSkipped: tasksSkipped,
    activitiesImported: activityImported,
    activitiesSkipped: activitySkipped,
    errors: errors
  };
}

// -------------------------------------------------------
// Export to Spreadsheet
// -------------------------------------------------------

function exportToSpreadsheet() {
  var cfg = getActiveConfig();
  if (!cfg.database.backupSpreadsheetId) {
    throw new Error('No backup spreadsheet configured');
  }
  var ssId = cfg.database.backupSpreadsheetId;

  var tasks = loadTasks();
  var tHeaders = getHeadersForType('Tasks');
  writeDumpSheet(ssId, '_Dump_Tasks', tHeaders, tasks);

  var activities = loadActivities();
  var aHeaders = getHeadersForType('Activities');
  writeDumpSheet(ssId, '_Dump_Activities', aHeaders, activities);

  return { sheetId: ssId };
}
