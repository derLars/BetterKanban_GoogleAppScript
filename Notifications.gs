// ============================================================
// Notifications.gs — Chat webhook dispatch, daily summary,
//                    vacation suppression
// ============================================================

// -------------------------------------------------------
// Daily Chat Summary
// -------------------------------------------------------

function sendDailyChatSummaries() {
  var cfg = getActiveConfig();
  var timeZone = cfg.app.timeZone || 'America/New_York';

  var users = loadUsers();
  var tasks = loadTasks();
  var activities = loadActivities();
  var today = Utilities.formatDate(new Date(), timeZone, 'yyyy-MM-dd');

  users.forEach(function(user) {
    if (!user.settings || !user.settings.chatWebhookUrl) return;
    if (isOnVacation(user, today)) return;

    var summary = buildSummary(user, tasks, activities, today, timeZone);
    if (!summary) return; // Nothing to report

    try {
      sendChatMessage(user.settings.chatWebhookUrl, summary);
    } catch (e) {
      // Log webhook failure silently (GAS will capture in execution log)
    }
  });
}

// -------------------------------------------------------
// Vacation Check
// -------------------------------------------------------

function isOnVacation(user, dateStr) {
  if (!user.settings || !user.settings.vacations) return false;
  for (var i = 0; i < user.settings.vacations.length; i++) {
    var v = user.settings.vacations[i];
    if (v.start && v.end && dateStr >= v.start && dateStr <= v.end) {
      return true;
    }
  }
  return false;
}

// -------------------------------------------------------
// Summary Builder
// -------------------------------------------------------

function buildSummary(user, tasks, activities, today, timeZone) {
  var lines = [];
  lines.push('**BetterKanban — Daily Summary for ' + user.displayName + '**');
  lines.push('');

  // Tasks assigned to user that are not completed
  var myOpenTasks = tasks.filter(function(t) {
    return t.assignedTo === user.email && !t.completedDate && !t.deletedDate;
  });

  if (myOpenTasks.length > 0) {
    lines.push('*Open Tasks (' + myOpenTasks.length + '):*');
    myOpenTasks.forEach(function(t) {
      lines.push('  • ' + t.description);
    });
    lines.push('');
  }

  // Tasks due today or overdue
  var dueTasks = tasks.filter(function(t) {
    if (!t.dueDate || t.completedDate || t.deletedDate) return false;
    return t.dueDate <= today + 'T23:59:59';
  });

  var dueTodayTasks = dueTasks.filter(function(t) {
    return t.dueDate.indexOf(today) === 0;
  });

  var overdueTasks = dueTasks.filter(function(t) {
    return t.dueDate < today;
  });

  if (dueTodayTasks.length > 0) {
    lines.push('*Due Today:*');
    dueTodayTasks.forEach(function(t) {
      lines.push('  • ' + t.description + (t.assignedTo ? ' (assigned to ' + getDisplayName(t.assignedTo) + ')' : ''));
    });
    lines.push('');
  }

  if (overdueTasks.length > 0) {
    lines.push('*Overdue:*');
    overdueTasks.forEach(function(t) {
      lines.push('  • ' + t.description + ' (due ' + t.dueDate.split('T')[0] + ')' +
        (t.assignedTo ? ' — ' + getDisplayName(t.assignedTo) : ''));
    });
    lines.push('');
  }

  // Activities assigned to user that are not completed
  var myOpenActivities = activities.filter(function(a) {
    return a.assignedTo === user.email && !a.completedDate && !a.deletedDate;
  });

  if (myOpenActivities.length > 0) {
    lines.push('*Open Activities (' + myOpenActivities.length + '):*');
    myOpenActivities.forEach(function(a) {
      var colName = 'Unknown';
      var cfg = getActiveConfig();
      cfg.kanban.columns.forEach(function(c) {
        if (c.id === a.columnId) colName = c.name;
      });
      lines.push('  • ' + a.title + ' [' + colName + ']');
    });
    lines.push('');
  }

  if (lines.length <= 2) return null; // Nothing to report

  lines.push('---');
  lines.push('_BetterKanban automatic notification_');

  return lines.join('\n');
}

// -------------------------------------------------------
// Webhook POST
// -------------------------------------------------------

function sendChatMessage(webhookUrl, message) {
  var payload = {
    text: message
  };

  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(webhookUrl, options);
  var responseCode = response.getResponseCode();
  if (responseCode < 200 || responseCode >= 300) {
    throw new Error('Webhook returned ' + responseCode + ': ' + response.getContentText());
  }
}
