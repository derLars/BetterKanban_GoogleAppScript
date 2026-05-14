// ============================================================
// Main.gs — doGet(), session handling, include() helper,
//           getInitialData(), getCurrentUser(), poll()
// ============================================================

// -------------------------------------------------------
// HTML Serving
// -------------------------------------------------------

function doGet() {
  var userEmail, user;
  try {
    userEmail = Session.getActiveUser().getEmail();
    user = registerUser(userEmail);
  } catch (e) {
    return HtmlService.createHtmlOutput('<html><body><h1>Access Denied</h1><p>' +
      e.message + '</p></body></html>')
      .setTitle('BetterKanban — Error');
  }

  var cfg = getActiveConfig();
  var template = HtmlService.createTemplateFromFile('Html/Index');
  template.userEmail = userEmail;
  template.userDisplayName = user ? user.displayName : '';
  template.isAdmin = user ? user.role === 'admin' : false;

  var output = template.evaluate()
    .setTitle(cfg.app.title || 'BetterKanban')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  return output;
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile('Html/' + filename).getContent();
}

// -------------------------------------------------------
// Session & Initialisation
// -------------------------------------------------------

function getCurrentUser() {
  var email = Session.getActiveUser().getEmail();
  return registerUser(email);
}

function getInitialData() {
  var email = Session.getActiveUser().getEmail();
  var user = registerUser(email);
  var cfg = getActiveConfig();
  var tasks = loadTasks();
  var activities = loadActivities();
  var columns = cfg.kanban.columns || [];

  // Filter tasks by visibility
  var visibleTasks = tasks.filter(function(t) {
    if (t.deletedDate && !t._showDeleted) return false;
    if (t.completedDate && !t._showCompleted) return false;
    if (t.visibility === 'private' && t.creatorEmail !== email) return false;
    return true;
  });

  // Attach display names for client rendering
  visibleTasks.forEach(function(t) {
    t._creatorName = getDisplayName(t.creatorEmail);
    t._assigneeName = t.assignedTo ? getDisplayName(t.assignedTo) : null;
  });

  activities.forEach(function(a) {
    a._creatorName = getDisplayName(a.creatorEmail);
    a._assigneeName = a.assignedTo ? getDisplayName(a.assignedTo) : null;
    if (a.comments) {
      a.comments.forEach(function(c) {
        c._authorName = getDisplayName(c.authorEmail);
      });
    }
  });

  var meta = loadMeta();
  return {
    user: user,
    tasks: visibleTasks,
    activities: activities,
    columns: columns,
    config: cfg,
    dbVersion: meta.version
  };
}

// -------------------------------------------------------
// Polling
// -------------------------------------------------------

function poll(lastVersion) {
  // Fast path: check CacheService dbVersion only
  var cachedVersion = CacheService.getScriptCache().get('dbVersion');
  if (cachedVersion !== null) {
    var cv = parseInt(cachedVersion, 10);
    if (cv === lastVersion) {
      return { changed: false };
    }
  }

  // Fallback: read authoritative version from Script Properties
  var meta = loadMeta();
  if (meta.version === lastVersion) {
    // Correct the cache
    try {
      CacheService.getScriptCache().put('dbVersion', String(meta.version), 21600);
    } catch (e) {}
    return { changed: false };
  }

  // Full data snapshot
  var email = Session.getActiveUser().getEmail();
  var cfg = getActiveConfig();
  var tasks = loadTasks();
  var activities = loadActivities();
  var columns = cfg.kanban.columns || [];

  var visibleTasks = tasks.filter(function(t) {
    if (t.deletedDate) return false;
    if (t.completedDate) return false;
    if (t.visibility === 'private' && t.creatorEmail !== email) return false;
    return true;
  });

  visibleTasks.forEach(function(t) {
    t._creatorName = getDisplayName(t.creatorEmail);
    t._assigneeName = t.assignedTo ? getDisplayName(t.assignedTo) : null;
  });

  activities.forEach(function(a) {
    a._creatorName = getDisplayName(a.creatorEmail);
    a._assigneeName = a.assignedTo ? getDisplayName(a.assignedTo) : null;
    if (a.comments) {
      a.comments.forEach(function(c) {
        c._authorName = getDisplayName(c.authorEmail);
      });
    }
  });

  return {
    changed: true,
    data: {
      user: getUser(email),
      tasks: visibleTasks,
      activities: activities,
      columns: columns,
      config: cfg
    },
    newVersion: meta.version
  };
}
