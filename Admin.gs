// ============================================================
// Admin.gs -- Admin page server logic
// -------------------------------------------------------
// All functions in this file MUST check isAdmin() first.
// ============================================================

// -------------------------------------------------------
// Admin Check
// -------------------------------------------------------

function checkAdmin() {
  var email = Session.getActiveUser().getEmail();
  if (!isAdmin(email)) {
    throw new Error('Forbidden');
  }
  return email;
}

// -------------------------------------------------------
// Admin List Management
// -------------------------------------------------------

function getAdminList() {
  checkAdmin();
  return PropertiesService.getScriptProperties().getProperty('admin') || '';
}

function saveAdminList(list) {
  checkAdmin();

  if (typeof list !== 'string') {
    throw new Error('Admin list must be a semicolon-separated string');
  }

  var emails = list.split(';')
    .map(function(s) { return s.trim(); })
    .filter(Boolean);

  // Basic email format validation
  var validEmails = emails.filter(function(e) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  });

  if (validEmails.length === 0) {
    throw new Error('At least one admin must remain');
  }

  PropertiesService.getScriptProperties().setProperty('admin', validEmails.join(';'));
  return { success: true };
}

// -------------------------------------------------------
// Configuration Management
// -------------------------------------------------------

function getConfig() {
  checkAdmin();
  var cfg = getActiveConfig();
  return JSON.stringify(cfg, null, 2);
}

function saveConfig(json) {
  checkAdmin();

  if (typeof json !== 'string') {
    throw new Error('Config must be a JSON string');
  }

  var parsed;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error('Invalid JSON: ' + e.message);
  }

  // Validate backup spreadsheet ID if provided
  if (parsed.database && parsed.database.backupSpreadsheetId) {
    try {
      SpreadsheetApp.openById(parsed.database.backupSpreadsheetId);
    } catch (e) {
      throw new Error('Spreadsheet not found or not accessible: ' +
        parsed.database.backupSpreadsheetId);
    }
  }

  // Write to the Drive config file
  var fileId = getConfigFileId();
  if (!fileId) {
    throw new Error('No config file ID set. First set the Config.json Drive file ID.');
  }
  var success = writeConfigToDrive(fileId, parsed);
  if (!success) {
    throw new Error('Could not write to config file. Check the file ID and permissions.');
  }
  incrementDbVersion();
  _activeConfig = null; // Force reload

  return { success: true };
}

// -------------------------------------------------------
// Config File ID Management
// -------------------------------------------------------

function getConfigFileIdAdmin() {
  checkAdmin();
  return getConfigFileId();
}

function setConfigFileIdAdmin(fileId) {
  checkAdmin();
  if (!fileId || fileId.trim() === '') {
    throw new Error('File ID is required');
  }
  // Validate the file exists and is readable
  try {
    var file = DriveApp.getFileById(fileId.trim());
    var content = file.getBlob().getDataAsString();
    JSON.parse(content); // Validate JSON
  } catch (e) {
    throw new Error('Cannot read config file: ' + e.message);
  }
  setConfigFileId(fileId.trim());
  _activeConfig = null; // Force reload
  return { success: true };
}

// -------------------------------------------------------
// User Deletion
// -------------------------------------------------------

function deleteUser(userEmail) {
  var adminEmail = checkAdmin();

  if (userEmail === adminEmail) {
    throw new Error('Cannot delete self');
  }

  var users = loadUsers();
  var userToDelete = null;
  var userIdx = -1;
  for (var i = 0; i < users.length; i++) {
    if (users[i].email === userEmail) {
      userToDelete = users[i];
      userIdx = i;
      break;
    }
  }
  if (!userToDelete) throw new Error('User not found');

  // Step 1: Generate spreadsheet dump
  var ss = getBackupSpreadsheet();
  var dumpName = '_Dump_Deleted_User_' + userEmail.replace(/[^a-zA-Z0-9]/g, '_');
  var tasks = loadTasks();
  var userTasks = tasks.filter(function(t) {
    return t.creatorEmail === userEmail || t.assignedTo === userEmail;
  });
  var tHeaders = getHeadersForType('Tasks');
  writeDumpSheet(ss.getId(), dumpName, tHeaders, userTasks);

  // Step 2: Hard-delete private tasks
  var updatedTasks = [];
  for (var ti = 0; ti < tasks.length; ti++) {
    var t = tasks[ti];
    if (t.creatorEmail === userEmail && t.visibility === 'private') {
      // Hard-delete
      continue;
    }
    if (t.creatorEmail === userEmail) {
      t.creatorEmail = '_deleted_';
      t.assignedTo = null;
    } else if (t.assignedTo === userEmail) {
      t.assignedTo = null;
    }
    updatedTasks.push(t);
  }
  saveTasks(updatedTasks);

  // Step 3: Handle activities
  var activities = loadActivities();
  for (var ai = 0; ai < activities.length; ai++) {
    var a = activities[ai];
    if (a.creatorEmail === userEmail) {
      a.creatorEmail = '_deleted_';
    }
    if (a.assignedTo === userEmail) {
      a.assignedTo = null;
    }
  }
  saveActivities(activities);

  // Step 4: Soft-delete user
  userToDelete.deletedDate = new Date().toISOString();
  users[userIdx] = userToDelete;
  saveUsers(users);

  incrementDbVersion();
  try { purgeIfNeeded(); } catch (e) {}

  return { dumpSheetName: dumpName };
}

// -------------------------------------------------------
// Snapshot Import
// -------------------------------------------------------

function getAvailableSnapshots() {
  checkAdmin();
  var meta = loadMeta();
  return meta.snapshots || [];
}

function importSnapshot(date, mode) {
  checkAdmin();

  if (!date || !mode || (mode !== 'merge' && mode !== 'overwrite')) {
    throw new Error('Invalid parameters. Required: date (YYYY-MM-DD), mode (merge|overwrite)');
  }

  var ss = getBackupSpreadsheet();
  var tasksSheetName = date + '_Tasks';
  var activitiesSheetName = date + '_Activities';

  var dumpedTasks = readDumpSheet(ss.getId(), tasksSheetName);
  var dumpedActivities = readDumpSheet(ss.getId(), activitiesSheetName);

  // Create revert dump
  var dateTag = generateDateTag();
  var revertSheets = createRevertDump(dateTag);

  var cfg = getActiveConfig();
  var columns = cfg.kanban.columns || [];

  if (mode === 'overwrite') {
    // Clear current data
    PropertiesService.getScriptProperties().deleteProperty('db_tasks');
    PropertiesService.getScriptProperties().deleteProperty('db_activities');
    try {
      CacheService.getScriptCache().remove('db_tasks');
      CacheService.getScriptCache().remove('db_activities');
    } catch (e) {}
  }

  // Import tasks
  var tasks = mode === 'merge' ? loadTasks() : [];
  var existingTaskIds = {};
  tasks.forEach(function(t) {
    if (t.deterministicId) existingTaskIds[t.deterministicId] = true;
  });

  var tasksImported = 0;
  var tasksSkipped = 0;
  var activityImported = 0;
  var activitySkipped = 0;
  var errors = 0;

  dumpedTasks.forEach(function(row) {
    if (!row.hashId && !row.deterministicId) {
      errors++;
      return;
    }
    var detId = row.deterministicId || row.hashId;
    if (existingTaskIds[detId]) {
      tasksSkipped++;
      return;
    }
    if (mode === 'overwrite') {
      if (!row.version) row.version = 1;
      tasks.push({
        id: row.id || generateUUID(),
        deterministicId: detId,
        description: row.description || '',
        creatorEmail: row.creatorEmail || '_deleted_',
        creationDate: row.creationDate || new Date().toISOString(),
        dueDate: row.dueDate || null,
        assignedTo: row.assignedTo || null,
        visibility: row.visibility || 'private',
        comment: row.comment || null,
        version: 1,
        completedDate: row.completedDate || null,
        deletedDate: row.deletedDate || null,
        lastModifiedDate: new Date().toISOString()
      });
    }
    tasksImported++;
  });
  saveTasks(tasks);

  // Import activities
  var activities = mode === 'merge' ? loadActivities() : [];
  var existingActivityIds = {};
  activities.forEach(function(a) {
    if (a.deterministicId) existingActivityIds[a.deterministicId] = true;
  });

  dumpedActivities.forEach(function(row) {
    if (!row.hashId && !row.deterministicId) {
      errors++;
      return;
    }
    var detId = row.deterministicId || row.hashId;
    if (existingActivityIds[detId]) {
      activitySkipped++;
      return;
    }

    // Determine target column (by 1-indexed position)
    var targetIndex = 0;
    var colNumber = parseInt(row.columnNumber, 10);
    if (!isNaN(colNumber) && colNumber >= 1 && colNumber <= columns.length) {
      targetIndex = colNumber - 1;
    }

    var comments = [];
    if (row.comments) {
      try {
        comments = JSON.parse(row.comments);
      } catch (e) {
        comments = [];
      }
    }

    activities.push({
      id: row.id || generateUUID(),
      deterministicId: detId,
      title: row.title || '',
      description: row.description || null,
      creatorEmail: row.creatorEmail || '_deleted_',
      creationDate: row.creationDate || new Date().toISOString(),
      dueDate: row.dueDate || null,
      assignedTo: row.assignedTo || null,
      columnIndex: targetIndex,
      columnOrder: parseInt(row.columnOrder, 10) || 0,
      comments: comments,
      version: 1,
      completedDate: row.completedDate || null,
      deletedDate: row.deletedDate || null,
      lastModifiedDate: new Date().toISOString()
    });
    activityImported++;
  });

  // Renumber columnOrder across all columns after import
  // Fix activities with out-of-range columnIndex
  activities.forEach(function(a) {
    if (a.columnIndex === undefined || a.columnIndex < 0 || a.columnIndex >= columns.length) {
      a.columnIndex = 0;
    }
  });

  // Renumber each column
  for (var ci = 0; ci < columns.length; ci++) {
    var colCards = activities.filter(function(a) {
      return a.columnIndex === ci;
    }).sort(function(a, b) { return a.columnOrder - b.columnOrder; });
    colCards.forEach(function(card, idx) {
      for (var ai = 0; ai < activities.length; ai++) {
        if (activities[ai].id === card.id) {
          activities[ai].columnOrder = idx;
          break;
        }
      }
    });
  }

  saveActivities(activities);

  incrementDbVersion();
  try {
    CacheService.getScriptCache().remove('db_tasks');
    CacheService.getScriptCache().remove('db_activities');
  } catch (e) {}

  return {
    imported: tasksImported + activityImported,
    tasksImported: tasksImported,
    tasksSkipped: tasksSkipped,
    activitiesImported: activityImported,
    activitiesSkipped: activitySkipped,
    errors: errors,
    revertSheet: revertSheets.tasksSheet + ' / ' + revertSheets.activitiesSheet
  };
}
