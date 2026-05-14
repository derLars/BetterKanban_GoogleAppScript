// ============================================================
// Triggers.gs -- Installable time-driven trigger management
// -------------------------------------------------------
// Run setupDailyTriggers() once from the GAS script editor
// after first deploy to install all triggers.
// ============================================================

// -------------------------------------------------------
// Setup All Triggers
// -------------------------------------------------------

function setupDailyTriggers() {
  // Remove all existing triggers to avoid duplicates
  var existingTriggers = ScriptApp.getProjectTriggers();
  existingTriggers.forEach(function(t) {
    ScriptApp.deleteTrigger(t);
  });

  var cfg = getActiveConfig().database;

  // Parse times from config (HH:MM format)
  var backupTimeParts = (cfg.backupTime || '02:00').split(':');
  var purgeTimeParts = (cfg.purgeTime || '03:00').split(':');
  var notificationTimeParts = (cfg.notificationTime || '08:00').split(':');

  var backupHour = parseInt(backupTimeParts[0], 10);
  var backupMinute = parseInt(backupTimeParts[1] || '0', 10);

  var purgeHour = parseInt(purgeTimeParts[0], 10);
  var purgeMinute = parseInt(purgeTimeParts[1] || '0', 10);

  var notificationHour = parseInt(notificationTimeParts[0], 10);
  var notificationMinute = parseInt(notificationTimeParts[1] || '0', 10);

  // 1. Daily backup at configured time
  ScriptApp.newTrigger('backupToSpreadsheet')
    .timeBased()
    .everyDays(1)
    .atHour(backupHour)
    .nearMinute(backupMinute)
    .create();

  // 2. Daily purge at configured time
  ScriptApp.newTrigger('purgeOldTasks')
    .timeBased()
    .everyDays(1)
    .atHour(purgeHour)
    .nearMinute(purgeMinute)
    .create();

  ScriptApp.newTrigger('purgeOldActivities')
    .timeBased()
    .everyDays(1)
    .atHour(purgeHour)
    .nearMinute(purgeMinute)
    .create();

  // 3. Daily notification summary at configured time
  ScriptApp.newTrigger('sendDailyChatSummaries')
    .timeBased()
    .everyDays(1)
    .atHour(notificationHour)
    .nearMinute(notificationMinute)
    .create();

  // 4. Keep-warm ping (every 5 minutes to reduce cold starts)
  ScriptApp.newTrigger('keepWarm')
    .timeBased()
    .everyMinutes(5)
    .create();
}

// -------------------------------------------------------
// Keep-Warm Ping
// -------------------------------------------------------

function keepWarm() {
  try {
    CacheService.getScriptCache().get('dbVersion');
  } catch (e) {
    // Silently ignore -- this is just a keep-warm ping
  }
}

// -------------------------------------------------------
// Remove All Triggers (cleanup)
// -------------------------------------------------------

function removeAllTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(t) {
    ScriptApp.deleteTrigger(t);
  });
}
