// ============================================================
// Database.gs — Script Properties read/write, backup logic,
//               config loading, deterministic ID computation,
//               short↔full key translation, cache management
// ============================================================

// -------------------------------------------------------
// Short↔Full Key Translation Maps
// -------------------------------------------------------
// All entities stored in Script Properties use short keys
// (1–4 chars) to save space. Client receives full keys.
// -------------------------------------------------------

var TASK_SHORT_TO_FULL = {
  i: 'id', di: 'deterministicId', dsc: 'description', cr: 'creatorEmail',
  crd: 'creationDate', dud: 'dueDate', asgn: 'assignedTo', vis: 'visibility',
  cmt: 'comment', ver: 'version', cpd: 'completedDate', dd: 'deletedDate',
  lmd: 'lastModifiedDate'
};

var USER_SHORT_TO_FULL = {
  e: 'email', dn: 'displayName', fad: 'firstAccessDate', lad: 'lastAccessDate',
  r: 'role', dd: 'deletedDate', s: 'settings'
};

var SETTINGS_SHORT_TO_FULL = {
  cwu: 'chatWebhookUrl', vac: 'vacations'
};

var VACATION_SHORT_TO_FULL = {
  s: 'start', e: 'end'
};

var ACTIVITY_SHORT_TO_FULL = {
  i: 'id', di: 'deterministicId', t: 'title', dsc: 'description',
  cr: 'creatorEmail', crd: 'creationDate', dud: 'dueDate', asgn: 'assignedTo',
  col: 'columnId', co: 'columnOrder', cmts: 'comments', ver: 'version',
  cpd: 'completedDate', dd: 'deletedDate', lmd: 'lastModifiedDate'
};

var COMMENT_SHORT_TO_FULL = {
  i: 'id', ae: 'authorEmail', crd: 'creationDate', lmd: 'lastModifiedDate',
  txt: 'text'
};

var COLUMN_SHORT_TO_FULL = {
  i: 'id', n: 'name', o: 'order'
};

// Inverted maps (full → short)
var TASK_FULL_TO_SHORT       = invertMapping(TASK_SHORT_TO_FULL);
var USER_FULL_TO_SHORT       = invertMapping(USER_SHORT_TO_FULL);
var SETTINGS_FULL_TO_SHORT   = invertMapping(SETTINGS_SHORT_TO_FULL);
var VACATION_FULL_TO_SHORT   = invertMapping(VACATION_SHORT_TO_FULL);
var ACTIVITY_FULL_TO_SHORT   = invertMapping(ACTIVITY_SHORT_TO_FULL);
var COMMENT_FULL_TO_SHORT    = invertMapping(COMMENT_SHORT_TO_FULL);
var COLUMN_FULL_TO_SHORT     = invertMapping(COLUMN_SHORT_TO_FULL);

function invertMapping(m) {
  var r = {};
  Object.keys(m).forEach(function(k) { r[m[k]] = k; });
  return r;
}

// -------------------------------------------------------
// Generic Key Translation
// -------------------------------------------------------

function translateKeys(obj, shortToFull, subMappings) {
  if (Array.isArray(obj)) {
    return obj.map(function(item) { return translateKeys(item, shortToFull, subMappings); });
  }
  if (obj === null || typeof obj !== 'object') return obj;
  var result = {};
  Object.keys(obj).forEach(function(key) {
    var newKey = (shortToFull && shortToFull[key]) || key;
    var value = obj[key];
    if (subMappings && subMappings[newKey] && value !== null && value !== undefined) {
      if (Array.isArray(value)) {
        value = value.map(function(item) { return translateKeys(item, subMappings[newKey], subMappings); });
      } else if (typeof value === 'object') {
        value = translateKeys(value, subMappings[newKey], subMappings);
      }
    }
    result[newKey] = value;
  });
  return result;
}

function translateTaskForClient(task) {
  return translateKeys(task, TASK_SHORT_TO_FULL);
}

function translateTaskForStorage(task) {
  return translateKeys(task, TASK_FULL_TO_SHORT);
}

function translateUserForClient(user) {
  var u = translateKeys(user, USER_SHORT_TO_FULL, null);
  if (u.settings && typeof u.settings === 'object') {
    u.settings = translateKeys(u.settings, SETTINGS_SHORT_TO_FULL, null);
    if (u.settings.vacations && Array.isArray(u.settings.vacations)) {
      u.settings.vacations = u.settings.vacations.map(function(v) {
        return translateKeys(v, VACATION_SHORT_TO_FULL);
      });
    }
  }
  return u;
}

function translateUserForStorage(user) {
  var u = translateKeys(user, USER_FULL_TO_SHORT, null);
  if (u.s && typeof u.s === 'object') {
    u.s = translateKeys(u.s, SETTINGS_FULL_TO_SHORT, null);
    if (u.s.vac && Array.isArray(u.s.vac)) {
      u.s.vac = u.s.vac.map(function(v) {
        return translateKeys(v, VACATION_FULL_TO_SHORT);
      });
    }
  }
  return u;
}

function translateActivityForClient(activity) {
  var a = translateKeys(activity, ACTIVITY_SHORT_TO_FULL, null);
  if (a.comments && Array.isArray(a.comments)) {
    a.comments = a.comments.map(function(c) {
      return translateKeys(c, COMMENT_SHORT_TO_FULL);
    });
  }
  return a;
}

function translateActivityForStorage(activity) {
  var a = translateKeys(activity, ACTIVITY_FULL_TO_SHORT, null);
  if (a.cmts && Array.isArray(a.cmts)) {
    a.cmts = a.cmts.map(function(c) {
      return translateKeys(c, COMMENT_FULL_TO_SHORT);
    });
  }
  return a;
}

function translateColumnsForClient(columns) {
  return columns.map(function(c) { return translateKeys(c, COLUMN_SHORT_TO_FULL); });
}

function translateColumnsForStorage(columns) {
  return columns.map(function(c) { return translateKeys(c, COLUMN_FULL_TO_SHORT); });
}

// -------------------------------------------------------
// Core Database Operations
// -------------------------------------------------------

function loadDatabaseRaw(key) {
  var sp = PropertiesService.getScriptProperties();
  var raw = sp.getProperty(key);
  if (!raw) return null;
  return JSON.parse(raw);
}

function saveDatabaseRaw(key, data) {
  var sp = PropertiesService.getScriptProperties();
  var json = JSON.stringify(data);
  sp.setProperty(key, json);
  try {
    CacheService.getScriptCache().put(key, json, 600);
  } catch (e) {}
}

function loadDatabase(key, translator) {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(key);
  var data;
  if (cached) {
    data = JSON.parse(cached);
  } else {
    var sp = PropertiesService.getScriptProperties();
    var raw = sp.getProperty(key);
    if (!raw) return (key === 'db_meta') ? { version: 0, snapshots: [] } : [];
    data = JSON.parse(raw);
    cache.put(key, raw, 600);
  }
  return translator ? data.map(function(item) { return translator(item); }) : data;
}

function saveDatabase(key, data, translator) {
  var sp = PropertiesService.getScriptProperties();
  var toStore = translator ? data.map(function(item) { return translator(item); }) : data;
  var json = JSON.stringify(toStore);
  sp.setProperty(key, json);
  try {
    CacheService.getScriptCache().put(key, json, 600);
  } catch (e) {}
}

// -------------------------------------------------------
// Entity-Specific Load/Save (with key translation)
// -------------------------------------------------------

function loadUsers() {
  return loadDatabase('db_users', translateUserForClient);
}

function saveUsers(users) {
  saveDatabase('db_users', users, translateUserForStorage);
}

function loadTasks() {
  return loadDatabase('db_tasks', translateTaskForClient);
}

function saveTasks(tasks) {
  saveDatabase('db_tasks', tasks, translateTaskForStorage);
}

function loadActivities() {
  return loadDatabase('db_activities', translateActivityForClient);
}

function saveActivities(activities) {
  saveDatabase('db_activities', activities, translateActivityForStorage);
}

// -------------------------------------------------------
// db_meta Management
// -------------------------------------------------------

function loadMeta() {
  var data = loadDatabaseRaw('db_meta');
  return data || { version: 0, snapshots: [] };
}

function saveMeta(meta) {
  saveDatabaseRaw('db_meta', meta);
}

function getDbVersion() {
  return loadMeta().version;
}

function incrementDbVersion() {
  var meta = loadMeta();
  meta.version += 1;
  saveMeta(meta);
  try {
    CacheService.getScriptCache().put('dbVersion', String(meta.version), 21600);
  } catch (e) {}
  return meta.version;
}

// -------------------------------------------------------
// Config Loading (merged: Config.json + configOverlay)
// -------------------------------------------------------

var _activeConfig = null;

function loadConfig() {
  var base = {
    app: { title: 'BetterKanban', timeZone: 'America/New_York', dateFormat: 'YYYY-MM-DD' },
    kanban: {
      columns: [
        { id: 'col-default', name: 'Activities', order: 0 }
      ],
      completedColumnId: null
    },
    database: {
      backupSpreadsheetId: '', backupTime: '02:00', purgeTime: '03:00',
      notificationTime: '08:00', backupSnapshotCount: 5,
      completedTaskMaxCount: 100, completedActivityMaxCount: 100,
      deletedTaskRetentionDays: 7, maxCommentsPerActivity: 50
    },
    ui: { theme: 'light', pageSize: 50, pollingIntervalSeconds: 10 }
  };

  try {
    var files = ScriptApp.getProject().getFiles();
    while (files.hasNext()) {
      var file = files.next();
      if (file.getName() === 'Config.json') {
        var parsed = JSON.parse(file.getContent());
        Object.keys(parsed).forEach(function(k) { base[k] = parsed[k]; });
        break;
      }
    }
  } catch (e) {}

  var overlay = PropertiesService.getScriptProperties().getProperty('configOverlay');
  if (overlay) {
    try {
      var overlayObj = JSON.parse(overlay);
      ['app', 'kanban', 'database', 'ui'].forEach(function(section) {
        if (overlayObj[section]) {
          Object.keys(overlayObj[section]).forEach(function(k) {
            base[section][k] = overlayObj[section][k];
          });
        }
      });
    } catch (e) {}
  }

  _activeConfig = base;
  return base;
}

function getActiveConfig() {
  if (!_activeConfig) return loadConfig();
  return _activeConfig;
}

// -------------------------------------------------------
// Deterministic ID (SHA-256, first 16 hex chars)
// -------------------------------------------------------

function computeDeterministicId(creatorEmail, creationDate, id) {
  var input = creatorEmail + '|' + creationDate + '|' + id;
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    input,
    Utilities.Charset.UTF_8
  );
  var hex = digest.map(function(b) {
    return ((b + 256) % 256).toString(16).padStart(2, '0');
  }).join('');
  return hex.substring(0, 16);
}

// -------------------------------------------------------
// UUID v4 Generator
// -------------------------------------------------------

function generateUUID() {
  return Utilities.getUuid();
}

// -------------------------------------------------------
// Backup Spreadsheet Operations
// -------------------------------------------------------

function getBackupSpreadsheet() {
  var cfg = getActiveConfig();
  var id = cfg.database.backupSpreadsheetId;
  if (!id) throw new Error('No backup spreadsheet configured');
  return SpreadsheetApp.openById(id);
}

var BACKUP_HEADERS = {
  Tasks: ['id', 'deterministicId', 'description', 'creatorEmail', 'creationDate', 'dueDate', 'assignedTo', 'visibility', 'comment', 'version', 'completedDate', 'deletedDate', 'lastModifiedDate'],
  Activities: ['id', 'deterministicId', 'title', 'description', 'creatorEmail', 'creationDate', 'dueDate', 'assignedTo', 'columnId', 'columnOrder', 'version', 'comments', 'completedDate', 'deletedDate', 'lastModifiedDate'],
  Users: ['email', 'displayName', 'firstAccessDate', 'lastAccessDate', 'deletedDate', 'role', 'settings']
};

function getHeadersForType(type) {
  return BACKUP_HEADERS[type] || [];
}

function formatCellValue(item, header) {
  if (header === 'comments' || header === 'settings') {
    return JSON.stringify(item[header] || '');
  }
  var val = item[header];
  return (val === null || val === undefined) ? '' : String(val);
}

function createSnapshotSheets(dateStr) {
  var ss = getBackupSpreadsheet();
  var types = ['Tasks', 'Activities', 'Users'];

  types.forEach(function(type) {
    var name = dateStr + '_' + type;
    var existing = ss.getSheetByName(name);
    if (existing) ss.deleteSheet(existing);

    var sheet = ss.insertSheet(name);
    var headers = getHeadersForType(type);
    sheet.appendRow(headers);

    var key = 'db_' + type.toLowerCase();
    var data;
    if (type === 'Tasks') data = loadTasks();
    else if (type === 'Activities') data = loadActivities();
    else if (type === 'Users') data = loadUsers();

    data.forEach(function(item) {
      var row = headers.map(function(h) { return formatCellValue(item, h); });
      try { sheet.appendRow(row); } catch (e) {}
    });
  });
}

function deleteSnapshotSheets(dateStr) {
  var ss = getBackupSpreadsheet();
  ['Tasks', 'Activities', 'Users'].forEach(function(type) {
    var sheet = ss.getSheetByName(dateStr + '_' + type);
    if (sheet) ss.deleteSheet(sheet);
  });
}

// -------------------------------------------------------
// Backup & Snapshot Rotation
// -------------------------------------------------------

function backupToSpreadsheet() {
  var meta = loadMeta();
  var today = Utilities.formatDate(new Date(), getActiveConfig().app.timeZone, 'yyyy-MM-dd');
  createSnapshotSheets(today);

  meta.snapshots = meta.snapshots || [];
  meta.snapshots.unshift(today);

  var maxSnapshots = getActiveConfig().database.backupSnapshotCount || 5;
  while (meta.snapshots.length > maxSnapshots) {
    var oldest = meta.snapshots.pop();
    try { deleteSnapshotSheets(oldest); } catch (e) {}
  }

  saveMeta(meta);
}

// -------------------------------------------------------
// Dump Sheet Operations (Import/Export)
// -------------------------------------------------------

function readDumpSheet(spreadsheetId, sheetName) {
  var ss, sheet;
  try {
    ss = SpreadsheetApp.openById(spreadsheetId);
    sheet = ss.getSheetByName(sheetName);
  } catch (e) {
    throw new Error('Spreadsheet not found: ' + spreadsheetId);
  }
  if (!sheet) return [];
  var rows = sheet.getDataRange().getValues();
  if (rows.length < 2) return [];
  var headers = rows[0];
  var data = [];
  for (var i = 1; i < rows.length; i++) {
    var row = {};
    for (var j = 0; j < headers.length; j++) {
      row[headers[j]] = (rows[i][j] === '' || rows[i][j] === undefined) ? null : rows[i][j];
    }
    data.push(row);
  }
  return data;
}

function writeDumpSheet(spreadsheetId, sheetName, headers, data) {
  var ss = SpreadsheetApp.openById(spreadsheetId);
  var existing = ss.getSheetByName(sheetName);
  if (existing) ss.deleteSheet(existing);
  var sheet = ss.insertSheet(sheetName);
  if (!data || data.length === 0) {
    sheet.appendRow(headers);
    return;
  }
  sheet.appendRow(headers);
  data.forEach(function(item) {
    var row = headers.map(function(h) { return formatCellValue(item, h); });
    sheet.appendRow(row);
  });
}

// -------------------------------------------------------
// Size Estimation & Auto-Purge Threshold
// -------------------------------------------------------

function estimateDatabaseSize() {
  var sp = PropertiesService.getScriptProperties();
  var keys = ['db_users', 'db_tasks', 'db_activities', 'db_meta', 'configOverlay', 'admin'];
  var total = 0;
  keys.forEach(function(k) {
    var v = sp.getProperty(k);
    if (v) total += v.length;
  });
  return total;
}

function purgeIfNeeded() {
  var size = estimateDatabaseSize();
  if (size > 400000) {
    var cfg = getActiveConfig().database;
    try { purgeOldTasksInternal(cfg); } catch (e) {}
    try { purgeOldActivitiesInternal(cfg); } catch (e) {}
  }
}

// -------------------------------------------------------
// Revert Dump Creation (before import)
// -------------------------------------------------------

function createRevertDump(dateTag) {
  var ss = getBackupSpreadsheet();
  var tasks = loadTasks();
  var activities = loadActivities();

  var tHeaders = getHeadersForType('Tasks');
  writeDumpSheet(ss.getId(), 'Revert_' + dateTag + '_Tasks', tHeaders, tasks);

  var aHeaders = getHeadersForType('Activities');
  writeDumpSheet(ss.getId(), 'Revert_' + dateTag + '_Activities', aHeaders, activities);

  return {
    tasksSheet: 'Revert_' + dateTag + '_Tasks',
    activitiesSheet: 'Revert_' + dateTag + '_Activities'
  };
}

function generateDateTag() {
  return Utilities.formatDate(new Date(), getActiveConfig().app.timeZone, 'yyyy-MM-dd\'T\'HHmmss');
}
