<script>
  // ================================================================
  // App.js — Client-side JS: state, rendering, API calls, DnD,
  //          search, polling, modals, keyboard shortcuts
  // ================================================================

  // ---------------------------------------------------------------
  // State
  // ---------------------------------------------------------------
  var state = {
    user: null,
    tasks: [],
    activities: [],
    columns: [],
    config: {},
    dbVersion: 0,
    tasksSearch: '',
    activitiesSearch: '',
    showCompletedTasks: false,
    showDeletedTasks: false,
    showCompletedActivities: false,
    showDeletedActivities: false,
    tasksPaneHidden: false,
    activitiesPaneHidden: false,
    loading: true,
    pollFailures: 0,
    pollInterval: null,
    currentEditId: null,
    currentEditType: null, // 'task' | 'activity'
    allUsers: [],
    _modifiedFields: {} // Track changed fields in current edit modal
  };

  // ---------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------
  function onInit(data) {
    state.loading = false;
    state.user = data.user;
    state.tasks = data.tasks || [];
    state.activities = data.activities || [];
    state.columns = data.columns || [];
    state.config = data.config || {};
    state.dbVersion = data.dbVersion || 0;

    // Fetch all users for dropdowns (asynchronous, non-blocking)
    google.script.run
      .withSuccessHandler(function(users) { state.allUsers = users || []; })
      .withFailureHandler(function() {})
      .getAllUsers();

    // Hide skeletons
    document.getElementById('bk-tasks-skeleton').style.display = 'none';
    document.getElementById('bk-kanban-skeleton').style.display = 'none';

    // Set up event delegation
    setupEventDelegation();

    // Initial render
    renderAll();

    // Start polling
    startPolling();

    // Register keyboard shortcuts
    setupKeyboardShortcuts();
  }

  // ---------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------
  function renderAll() {
    renderWelcome();
    renderTasks();
    renderKanban();
    updateTopBar();
  }

  function updateTopBar() {
    if (state.user) {
      document.getElementById('bk-user-name').textContent = state.user.displayName || state.user.email;
      var avatar = document.getElementById('bk-avatar');
      avatar.textContent = (state.user.displayName || state.user.email || 'U').charAt(0).toUpperCase();
      // Derive avatar color from email hash
      var hash = 0;
      for (var i = 0; i < (state.user.email || '').length; i++) {
        hash = state.user.email.charCodeAt(i) + ((hash << 5) - hash);
      }
      var hue = Math.abs(hash) % 360;
      avatar.style.background = 'hsl(' + hue + ', 50%, 45%)';
    }
    // Admin tab visibility
    var adminTab = document.getElementById('bk-admin-tab');
    if (state.user && state.user.role === 'admin') {
      adminTab.classList.remove('bk-hidden');
    } else {
      adminTab.classList.add('bk-hidden');
    }
  }

  // ---------------------------------------------------------------
  // Welcome Bar
  // ---------------------------------------------------------------
  function renderWelcome() {
    if (!state.user) return;
    document.getElementById('bk-welcome-name').textContent = state.user.displayName || '';

    var allTasks = state.tasks || [];
    var assignedToMe = allTasks.filter(function(t) {
      return t.assignedTo === state.user.email && !t.completedDate && !t.deletedDate;
    });
    var today = new Date().toISOString().split('T')[0];
    var dueToday = allTasks.filter(function(t) {
      return t.dueDate && t.dueDate.indexOf(today) === 0 && !t.completedDate && !t.deletedDate;
    });
    var overdue = allTasks.filter(function(t) {
      return t.dueDate && t.dueDate < today + 'T' && !t.completedDate && !t.deletedDate;
    });
    var activeCards = (state.activities || []).filter(function(a) {
      return !a.completedDate && !a.deletedDate;
    });

    var counters = document.getElementById('bk-welcome-counters');
    var html = '';
    if (assignedToMe.length > 0) html += '<span class="bk-welcome__pill">' + assignedToMe.length + ' assigned</span>';
    if (dueToday.length > 0) html += '<span class="bk-welcome__pill bk-welcome__pill--due-today">' + dueToday.length + ' due today</span>';
    if (overdue.length > 0) html += '<span class="bk-welcome__pill bk-welcome__pill--overdue">' + overdue.length + ' overdue</span>';
    html += '<span class="bk-welcome__pill">' + activeCards.length + ' active cards</span>';
    counters.innerHTML = html;
  }

  // ---------------------------------------------------------------
  // Task List Rendering
  // ---------------------------------------------------------------
  function renderTasks() {
    var body = document.getElementById('bk-tasks-body');
    var tasks = filterTasks();

    if (tasks.length === 0) {
      body.innerHTML =
        '<div class="bk-empty">' +
          '<div class="bk-empty__icon">📋</div>' +
          '<div class="bk-empty__msg">No tasks yet</div>' +
          '<div class="bk-empty__sub">Create your first task to get started.</div>' +
        '</div>';
      return;
    }

    var html = '<div class="bk-task-list">';
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      var isCompleted = !!t.completedDate;
      var isPublic = t.visibility === 'public';
      var completedClass = isCompleted ? ' bk-task-card--completed' : '';
      var checkedClass = isCompleted ? ' bk-task-card__checkbox--checked' : '';

      html += '<div class="bk-task-card' + completedClass + '" data-task-id="' + escapeHtml(t.id) + '">';
      html += '<div class="bk-task-card__row">';
      html += '<div class="bk-task-card__checkbox' + checkedClass + '" data-action="toggle-complete" data-task-id="' + escapeHtml(t.id) + '"></div>';
      html += '<span class="bk-task-card__desc">' + escapeHtml(t.description || '') + '</span>';
      html += '<span class="bk-task-card__badge bk-task-card__badge--' + (isPublic ? 'public' : 'private') + '">' + (isPublic ? '🔓' : '🔒') + '</span>';
      html += '</div>';
      if (t.assignedTo) {
        html += '<div class="bk-task-card__meta">👤 ' + escapeHtml(t._assigneeName || t.assignedTo) + '</div>';
      }
      if (t.comment) {
        var preview = t.comment.length > 80 ? t.comment.substring(0, 80) + '…' : t.comment;
        html += '<div class="bk-task-card__comment">💬 ' + escapeHtml(preview) + '</div>';
      }
      html += '</div>';
    }
    html += '</div>';
    body.innerHTML = html;
  }

  function filterTasks() {
    var tasks = state.tasks || [];
    var email = state.user ? state.user.email : '';

    return tasks.filter(function(t) {
      // Visibility filter
      if (t.visibility === 'private' && t.creatorEmail !== email) return false;
      // Deleted filter
      if (!state.showDeletedTasks && t.deletedDate) return false;
      // Completed filter
      if (!state.showCompletedTasks && t.completedDate) return false;
      // Search filter
      if (state.tasksSearch) {
        var q = state.tasksSearch.toLowerCase();
        var match = (t.description || '').toLowerCase().indexOf(q) !== -1 ||
                    (t._assigneeName || '').toLowerCase().indexOf(q) !== -1 ||
                    (t._creatorName || '').toLowerCase().indexOf(q) !== -1 ||
                    (t.comment || '').toLowerCase().indexOf(q) !== -1;
        if (!match) return false;
      }
      return true;
    });
  }

  // ---------------------------------------------------------------
  // Kanban Rendering
  // ---------------------------------------------------------------
  function renderKanban() {
    var body = document.getElementById('bk-activities-body');
    var activities = filterActivities();
    var columns = state.columns && state.columns.length > 0 ? state.columns : [{ id: 'col-default', name: 'Activities', order: 0 }];

    if (activities.length === 0 && columns.length > 0) {
      var hasAnyInColumn = {};
      columns.forEach(function(c) { hasAnyInColumn[c.id] = false; });
      // If no activities at all, show empty state
      if (state.activities.filter(function(a) { return !a.deletedDate; }).length === 0) {
        body.innerHTML =
          '<div class="bk-empty">' +
            '<div class="bk-empty__icon">📊</div>' +
            '<div class="bk-empty__msg">No activities yet</div>' +
            '<div class="bk-empty__sub">Add an activity card to start your Kanban board.</div>' +
          '</div>';
        return;
      }
    }

    var html = '<div class="bk-kanban">';
    for (var ci = 0; ci < columns.length; ci++) {
      var col = columns[ci];
      var colActivities = activities.filter(function(a) { return a.columnId === col.id; })
        .sort(function(a, b) { return (a.columnOrder || 0) - (b.columnOrder || 0); });

      html += '<div class="bk-column" data-column-id="' + escapeHtml(col.id) + '">';
      html += '<div class="bk-column__header">';
      html += '<span class="bk-column__name">' + escapeHtml(col.name || '') + '</span>';
      html += '<span class="bk-column__count">' + colActivities.length + '</span>';
      html += '</div>';
      html += '<div class="bk-column__body" data-column-id="' + escapeHtml(col.id) + '">';

      // Drop zone at top
      html += '<div class="bk-column__drop-zone" data-drop-index="0" data-column-id="' + escapeHtml(col.id) + '"></div>';

      for (var ai = 0; ai < colActivities.length; ai++) {
        var a = colActivities[ai];
        html += renderActivityCard(a);
        // Drop zone after each card
        html += '<div class="bk-column__drop-zone" data-drop-index="' + (ai + 1) + '" data-column-id="' + escapeHtml(col.id) + '"></div>';
      }

      html += '</div>'; // column__body
      html += '</div>'; // column
    }
    html += '</div>'; // kanban
    body.innerHTML = html;
  }

  function renderActivityCard(a) {
    var isCompleted = !!a.completedDate;
    var dueClass = '';
    if (a.dueDate) {
      var today = new Date().toISOString().split('T')[0];
      if (a.dueDate < today) dueClass = ' bk-activity-card__due--overdue';
      else if (a.dueDate.indexOf(today) === 0) dueClass = ' bk-activity-card__due--today';
    }
    var lastComment = '';
    if (a.comments && a.comments.length > 0) {
      var latest = a.comments[0];
      lastComment = latest.text ? latest.text.substring(0, 40) : '';
      if (latest.text && latest.text.length > 40) lastComment += '…';
    }
    var completedClass = isCompleted ? ' bk-activity-card--completed' : '';

    var html = '<div class="bk-activity-card' + completedClass + '" draggable="true" data-activity-id="' + escapeHtml(a.id) + '" data-version="' + (a.version || 1) + '">';
    html += '<div class="bk-activity-card__title">' + escapeHtml(a.title || '') + '</div>';
    if (a.description) {
      html += '<div class="bk-activity-card__desc">' + escapeHtml(a.description) + '</div>';
    }
    html += '<div class="bk-activity-card__footer">';
    if (a.dueDate) {
      html += '<span class="bk-activity-card__due' + dueClass + '">📅 ' + escapeHtml(a.dueDate.split('T')[0]) + '</span>';
    }
    if (a.assignedTo) {
      // Use first name only for card display
      var firstName = a._assigneeName ? a._assigneeName.split(' ')[0] : a.assignedTo;
      html += '<span class="bk-activity-card__assignee">👤 ' + escapeHtml(firstName) + '</span>';
    }
    if (lastComment) {
      html += '<span class="bk-activity-card__comment-preview">💬 "' + escapeHtml(lastComment) + '"</span>';
    }
    html += '</div>';
    html += '</div>';
    return html;
  }

  function filterActivities() {
    var activities = state.activities || [];
    return activities.filter(function(a) {
      if (!state.showDeletedActivities && a.deletedDate) return false;
      if (!state.showCompletedActivities && a.completedDate) return false;
      if (state.activitiesSearch) {
        var q = state.activitiesSearch.toLowerCase();
        var match = (a.title || '').toLowerCase().indexOf(q) !== -1 ||
                    (a.description || '').toLowerCase().indexOf(q) !== -1 ||
                    (a._assigneeName || '').toLowerCase().indexOf(q) !== -1;
        if (!match && a.comments) {
          for (var i = 0; i < a.comments.length; i++) {
            if ((a.comments[i].text || '').toLowerCase().indexOf(q) !== -1) {
              match = true;
              break;
            }
          }
        }
        if (!match) return false;
      }
      return true;
    });
  }

  // ---------------------------------------------------------------
  // Task Detail Modal
  // ---------------------------------------------------------------
  function openTaskModal(taskId) {
    // Fetch fresh task data
    google.script.run
      .withSuccessHandler(function(task) {
        renderTaskDetailModal(task);
      })
      .withFailureHandler(function(err) {
        showErrorToast('Could not load task: ' + (err.message || 'Unknown error'));
      })
      .getTask(taskId);
  }

  function renderTaskDetailModal(task) {
    state.currentEditId = task.id;
    state.currentEditType = 'task';
    state._modifiedFields = {};

    var body = document.getElementById('bk-modal-task-body');
    var email = state.user ? state.user.email : '';
    var canChangeVisibility = task.creatorEmail === email || (state.user && state.user.role === 'admin');

    body.innerHTML =
      '<div class="bk-field">' +
        '<label class="bk-field__label">Description *</label>' +
        '<textarea class="bk-field__textarea" id="bk-edit-task-desc" data-field="description">' + escapeHtml(task.description || '') + '</textarea>' +
      '</div>' +
      '<div class="bk-field__row">' +
        '<div class="bk-field">' +
          '<label class="bk-field__label">Due date</label>' +
          '<input class="bk-field__input" type="date" id="bk-edit-task-due" data-field="dueDate" value="' + (task.dueDate ? task.dueDate.split('T')[0] : '') + '">' +
        '</div>' +
        '<div class="bk-field">' +
          '<label class="bk-field__label">Assigned to</label>' +
          '<select class="bk-field__select" id="bk-edit-task-assignee" data-field="assignedTo">' +
            '<option value="">— Unassigned —</option>' +
            buildUserOptions(task.assignedTo) +
          '</select>' +
        '</div>' +
      '</div>' +
      '<div class="bk-field">' +
        '<label class="bk-field__label">Visibility</label>' +
        '<div>' +
          '<select class="bk-field__select" id="bk-edit-task-visibility" data-field="visibility"' + (canChangeVisibility ? '' : ' disabled') + '>' +
            '<option value="private" ' + (task.visibility === 'private' ? 'selected' : '') + '>🔒 Private</option>' +
            '<option value="public" ' + (task.visibility === 'public' ? 'selected' : '') + '>🔓 Public</option>' +
          '</select>' +
          (!canChangeVisibility ? '<div class="bk-field__meta">Only the creator or an admin can change visibility.</div>' : '') +
        '</div>' +
      '</div>' +
      '<div class="bk-field">' +
        '<label class="bk-field__label">Comment</label>' +
        '<textarea class="bk-field__textarea" id="bk-edit-task-comment" data-field="comment">' + escapeHtml(task.comment || '') + '</textarea>' +
      '</div>' +
      '<div class="bk-field__meta">Created by ' + escapeHtml(task._creatorName || task.creatorEmail) + ' on ' + (task.creationDate ? task.creationDate.split('T')[0] : '—') + '</div>';

    // Reset and show modal
    document.getElementById('bk-modal-task').classList.add('bk-modal-overlay--open');

    // Populate actions
    var actions = document.getElementById('bk-modal-task-actions');
    actions.innerHTML =
      '<button class="bk-btn bk-btn--primary" id="bk-edit-task-update" data-action="update-task">Update</button>' +
      '<button class="bk-btn bk-btn--success" id="bk-edit-task-complete" data-action="' + (task.completedDate ? 'uncomplete-task' : 'complete-task') + '">' +
        (task.completedDate ? 'Uncomplete' : 'Complete') +
      '</button>' +
      '<button class="bk-btn bk-btn--danger" id="bk-edit-task-delete" data-action="' + (task.deletedDate ? 'undelete-task' : 'delete-task') + '">' +
        (task.deletedDate ? 'Undelete' : 'Delete') +
      '</button>' +
      '<button class="bk-btn bk-btn--secondary" data-close-modal>Close</button>';

    // Hack: store task version for update
    actions.dataset.taskVersion = task.version || 1;

    // Track field changes
    body.querySelectorAll('[data-field]').forEach(function(el) {
      el.addEventListener('change', function() { trackFieldChange(el); });
      el.addEventListener('input', function() { trackFieldChange(el); });
    });
  }

  function trackFieldChange(el) {
    var field = el.dataset.field;
    var value = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'date' && !value) value = null;
    if (value === '' && field !== 'description') value = null;
    state._modifiedFields[field] = value;
  }

  function buildUserOptions(selectedEmail) {
    var html = '';
    for (var i = 0; i < state.allUsers.length; i++) {
      var u = state.allUsers[i];
      var sel = u.email === selectedEmail ? ' selected' : '';
      html += '<option value="' + escapeHtml(u.email) + '"' + sel + '>' + escapeHtml(u.displayName || u.email) + '</option>';
    }
    return html;
  }

  function closeAllModals() {
    document.querySelectorAll('.bk-modal-overlay').forEach(function(el) {
      el.classList.remove('bk-modal-overlay--open');
    });
    state.currentEditId = null;
    state.currentEditType = null;
    state._modifiedFields = {};
  }

  // ---------------------------------------------------------------
  // Activity Detail Modal
  // ---------------------------------------------------------------
  function openActivityModal(activityId) {
    google.script.run
      .withSuccessHandler(function(activity) {
        renderActivityDetailModal(activity);
      })
      .withFailureHandler(function(err) {
        showErrorToast('Could not load activity: ' + (err.message || 'Unknown error'));
      })
      .getActivity(activityId);
  }

  function renderActivityDetailModal(activity) {
    state.currentEditId = activity.id;
    state.currentEditType = 'activity';
    state._modifiedFields = {};

    var body = document.getElementById('bk-modal-activity-body');

    // Build comments HTML
    var commentsHtml = '<div class="bk-section"><div class="bk-section__title">Comments</div>';
    if (activity.comments && activity.comments.length > 0) {
      for (var i = 0; i < activity.comments.length; i++) {
        var c = activity.comments[i];
        commentsHtml +=
          '<div class="bk-comment" data-comment-id="' + escapeHtml(c.id) + '">' +
            '<div class="bk-comment__header">' +
              '<span class="bk-comment__author">' + escapeHtml(c._authorName || c.authorEmail) + '</span>' +
              '<span class="bk-comment__date">' + formatDate(c.creationDate) + '</span>' +
              '<span class="bk-comment__actions">' +
                '<button class="bk-comment__btn" data-action="edit-comment" data-comment-id="' + escapeHtml(c.id) + '">✏</button>' +
                '<button class="bk-comment__btn" data-action="delete-comment" data-comment-id="' + escapeHtml(c.id) + '">🗑</button>' +
              '</span>' +
            '</div>' +
            '<div class="bk-comment__text" data-comment-text="' + escapeHtml(c.id) + '">' + escapeHtml(c.text || '') + '</div>' +
          '</div>';
      }
    } else {
      commentsHtml += '<div class="bk-text-muted bk-text-sm">No comments yet.</div>';
    }
    commentsHtml +=
      '<div class="bk-field bk-mt-md">' +
        '<textarea class="bk-field__textarea" id="bk-new-comment-text" placeholder="Write a comment…" style="min-height:40px;"></textarea>' +
        '<button class="bk-btn bk-btn--primary bk-btn--sm bk-mt-sm" id="bk-add-comment-btn">Add</button>' +
      '</div>';
    commentsHtml += '</div>';

    body.innerHTML =
      '<div class="bk-field">' +
        '<label class="bk-field__label">Title *</label>' +
        '<input class="bk-field__input" type="text" id="bk-edit-activity-title" data-field="title" value="' + escapeHtml(activity.title || '') + '">' +
      '</div>' +
      '<div class="bk-field__row">' +
        '<div class="bk-field">' +
          '<label class="bk-field__label">Due date</label>' +
          '<input class="bk-field__input" type="date" id="bk-edit-activity-due" data-field="dueDate" value="' + (activity.dueDate ? activity.dueDate.split('T')[0] : '') + '">' +
        '</div>' +
        '<div class="bk-field">' +
          '<label class="bk-field__label">Assigned to</label>' +
          '<select class="bk-field__select" id="bk-edit-activity-assignee" data-field="assignedTo">' +
            '<option value="">— Unassigned —</option>' +
            buildUserOptions(activity.assignedTo) +
          '</select>' +
        '</div>' +
      '</div>' +
      '<div class="bk-field">' +
        '<label class="bk-field__label">Description</label>' +
        '<textarea class="bk-field__textarea" id="bk-edit-activity-desc" data-field="description">' + escapeHtml(activity.description || '') + '</textarea>' +
      '</div>' +
      commentsHtml +
      '<div class="bk-field__meta">Created by ' + escapeHtml(activity._creatorName || activity.creatorEmail) + ' on ' + (activity.creationDate ? activity.creationDate.split('T')[0] : '—') + '</div>';

    document.getElementById('bk-modal-activity').classList.add('bk-modal-overlay--open');

    var actions = document.getElementById('bk-modal-activity-actions');
    actions.innerHTML =
      '<button class="bk-btn bk-btn--primary" id="bk-edit-activity-update" data-action="update-activity">Update</button>' +
      '<button class="bk-btn bk-btn--success" id="bk-edit-activity-complete" data-action="' + (activity.completedDate ? 'uncomplete-activity' : 'complete-activity') + '">' +
        (activity.completedDate ? 'Uncomplete' : 'Complete') +
      '</button>' +
      '<button class="bk-btn bk-btn--danger" id="bk-edit-activity-delete" data-action="' + (activity.deletedDate ? 'undelete-activity' : 'delete-activity') + '">' +
        (activity.deletedDate ? 'Undelete' : 'Delete') +
      '</button>' +
      '<button class="bk-btn bk-btn--secondary" data-close-modal>Close</button>';

    actions.dataset.activityVersion = activity.version || 1;

    body.querySelectorAll('[data-field]').forEach(function(el) {
      el.addEventListener('change', function() { trackFieldChange(el); });
      el.addEventListener('input', function() { trackFieldChange(el); });
    });
  }

  // ---------------------------------------------------------------
  // Toast System
  // ---------------------------------------------------------------
  function showToast(message, type, duration, undoCallback) {
    type = type || 'success';
    duration = duration || 3000;

    var container = document.getElementById('bk-toast-container');
    var toast = document.createElement('div');
    toast.className = 'bk-toast bk-toast--' + type;

    var icons = { success: '✅', error: '❌', warning: '⚠', info: 'ℹ' };
    toast.innerHTML =
      '<span class="bk-toast__icon">' + (icons[type] || 'ℹ') + '</span>' +
      '<span class="bk-toast__msg">' + escapeHtml(message) + '</span>';

    if (undoCallback) {
      var undoBtn = document.createElement('button');
      undoBtn.className = 'bk-toast__action';
      undoBtn.textContent = 'Undo';
      undoBtn.addEventListener('click', function() {
        undoCallback();
        removeToast(toast);
      });
      toast.appendChild(undoBtn);
      duration = 5000;
    }

    var dismissBtn = document.createElement('button');
    dismissBtn.className = 'bk-toast__dismiss';
    dismissBtn.textContent = '✕';
    dismissBtn.addEventListener('click', function() { removeToast(toast); });
    toast.appendChild(dismissBtn);

    container.appendChild(toast);

    // Limit to 3 visible toasts
    while (container.children.length > 3) {
      container.removeChild(container.firstChild);
    }

    if (duration > 0) {
      setTimeout(function() { removeToast(toast); }, duration);
    }
  }

  function removeToast(toast) {
    if (toast.parentNode) {
      toast.parentNode.removeChild(toast);
    }
  }

  function showSuccessToast(msg) { showToast(msg, 'success', 3000); }
  function showErrorToast(msg) { showToast(msg, 'error', 5000); }
  function showWarningToast(msg, undoCallback) { showToast(msg, 'warning', 5000, undoCallback); }
  function showInfoToast(msg) { showToast(msg, 'info', 3000); }

  // ---------------------------------------------------------------
  // Event Delegation
  // ---------------------------------------------------------------
  function setupEventDelegation() {
    document.addEventListener('click', function(e) {
      var target = e.target;

      // Close modal via backdrop click
      if (target.classList.contains('bk-modal-overlay--open')) {
        closeAllModals();
        return;
      }

      // Close modal via [data-close-modal]
      if (target.hasAttribute('data-close-modal')) {
        closeAllModals();
        return;
      }

      // Task filter buttons
      if (target.hasAttribute('data-filter')) {
        var filter = target.getAttribute('data-filter');
        if (filter === 'completed-tasks') {
          state.showCompletedTasks = !state.showCompletedTasks;
          target.classList.toggle('bk-pane__filter-btn--active');
          renderTasks();
        } else if (filter === 'deleted-tasks') {
          state.showDeletedTasks = !state.showDeletedTasks;
          target.classList.toggle('bk-pane__filter-btn--active');
          renderTasks();
        } else if (filter === 'completed-activities') {
          state.showCompletedActivities = !state.showCompletedActivities;
          target.classList.toggle('bk-pane__filter-btn--active');
          renderKanban();
        } else if (filter === 'deleted-activities') {
          state.showDeletedActivities = !state.showDeletedActivities;
          target.classList.toggle('bk-pane__filter-btn--active');
          renderKanban();
        }
        return;
      }

      // Tab navigation
      if (target.classList.contains('bk-topbar__tab')) {
        document.querySelectorAll('.bk-topbar__tab').forEach(function(t) {
          t.classList.remove('bk-topbar__tab--active');
        });
        target.classList.add('bk-topbar__tab--active');
        var tab = target.getAttribute('data-tab');
        if (tab === 'admin') {
          openAdminModal();
        }
        return;
      }

      // User menu toggle
      if (target.closest('#bk-user-menu')) {
        var dropdown = document.getElementById('bk-user-dropdown');
        dropdown.classList.toggle('bk-user-dropdown--open');
        return;
      }

      // User dropdown actions
      if (target.hasAttribute('data-action') && target.closest('#bk-user-dropdown')) {
        var action = target.getAttribute('data-action');
        document.getElementById('bk-user-dropdown').classList.remove('bk-user-dropdown--open');
        if (action === 'settings') {
          openSettingsModal();
        } else if (action === 'close-session') {
          closeSession();
        }
        return;
      }

      // Pane toggle
      if (target.id === 'bk-toggle-tasks') {
        togglePane('tasks');
        return;
      }
      if (target.id === 'bk-toggle-activities') {
        togglePane('activities');
        return;
      }

      // Add new task/activity buttons
      if (target.id === 'bk-add-task') {
        openNewTaskModal();
        return;
      }
      if (target.id === 'bk-add-activity') {
        openNewActivityModal();
        return;
      }

      // Task card click (open detail modal)
      var taskCard = target.closest('.bk-task-card');
      if (taskCard && !target.closest('.bk-task-card__checkbox')) {
        var taskId = taskCard.getAttribute('data-task-id');
        if (taskId) openTaskModal(taskId);
        return;
      }

      // Task checkbox toggle
      if (target.hasAttribute('data-action') && target.getAttribute('data-action') === 'toggle-complete') {
        var taskId = target.getAttribute('data-task-id');
        var task = findTaskById(taskId);
        if (task) {
          if (task.completedDate) {
            uncompleteTask(taskId, task.version);
          } else {
            completeTask(taskId, task.version);
          }
        }
        return;
      }

      // Activity card click (open detail modal)
      var activityCard = target.closest('.bk-activity-card');
      if (activityCard) {
        var activityId = activityCard.getAttribute('data-activity-id');
        if (activityId) openActivityModal(activityId);
        return;
      }

      // Modal action buttons (inside task/activity modals)
      if (target.id === 'bk-edit-task-update') {
        saveTaskFromModal();
        return;
      }
      if (target.id === 'bk-edit-task-complete') {
        var action = target.getAttribute('data-action');
        var taskId = state.currentEditId;
        if (taskId) {
          if (action === 'complete-task') {
            completeTask(taskId, getModalVersion('task'), function() { closeAllModals(); });
          } else {
            uncompleteTask(taskId, getModalVersion('task'), function() { closeAllModals(); });
          }
        }
        return;
      }
      if (target.id === 'bk-edit-task-delete') {
        var action = target.getAttribute('data-action');
        var taskId = state.currentEditId;
        if (taskId) {
          if (action === 'delete-task') {
            if (confirm('Delete this task?')) {
              deleteTask(taskId, getModalVersion('task'), function() { closeAllModals(); });
            }
          } else {
            undeleteTask(taskId, getModalVersion('task'), function() { closeAllModals(); });
          }
        }
        return;
      }

      if (target.id === 'bk-edit-activity-update') {
        saveActivityFromModal();
        return;
      }
      if (target.id === 'bk-edit-activity-complete') {
        var action = target.getAttribute('data-action');
        var activityId = state.currentEditId;
        if (activityId) {
          if (action === 'complete-activity') {
            completeActivity(activityId, getModalVersion('activity'), function() { closeAllModals(); });
          } else {
            uncompleteActivity(activityId, getModalVersion('activity'), function() { closeAllModals(); });
          }
        }
        return;
      }
      if (target.id === 'bk-edit-activity-delete') {
        var action = target.getAttribute('data-action');
        var activityId = state.currentEditId;
        if (activityId) {
          if (action === 'delete-activity') {
            if (confirm('Delete this activity?')) {
              deleteActivity(activityId, getModalVersion('activity'), function() { closeAllModals(); });
            }
          } else {
            undeleteActivity(activityId, getModalVersion('activity'), function() { closeAllModals(); });
          }
        }
        return;
      }

      // Comment actions
      if (target.hasAttribute('data-action') && target.getAttribute('data-action') === 'edit-comment') {
        var commentId = target.getAttribute('data-comment-id');
        var commentBlock = target.closest('.bk-comment');
        if (commentBlock) {
          var textEl = commentBlock.querySelector('[data-comment-text]');
          var text = textEl ? textEl.textContent : '';
          textEl.innerHTML =
            '<textarea class="bk-comment__edit-area" id="bk-edit-comment-area">' + escapeHtml(text) + '</textarea>' +
            '<div class="bk-flex bk-flex--gap bk-mt-sm">' +
              '<button class="bk-btn bk-btn--primary bk-btn--sm" data-action="save-comment" data-comment-id="' + escapeHtml(commentId) + '">Save</button>' +
              '<button class="bk-btn bk-btn--secondary bk-btn--sm" data-action="cancel-edit-comment">Cancel</button>' +
            '</div>';
        }
        return;
      }

      if (target.hasAttribute('data-action') && target.getAttribute('data-action') === 'save-comment') {
        var commentId = target.getAttribute('data-comment-id');
        var textarea = document.getElementById('bk-edit-comment-area');
        if (textarea && state.currentEditId) {
          var newText = textarea.value;
          if (newText.trim()) {
            updateComment(state.currentEditId, commentId, newText, function(activity) {
              replaceActivityInState(activity);
              closeAllModals();
              // Don't re-open - user can click card again
              showSuccessToast('Comment updated');
            });
          }
        }
        return;
      }

      if (target.hasAttribute('data-action') && target.getAttribute('data-action') === 'cancel-edit-comment') {
        // Re-render the activity modal to reset the comment
        if (state.currentEditId) {
          openActivityModal(state.currentEditId);
        }
        return;
      }

      if (target.hasAttribute('data-action') && target.getAttribute('data-action') === 'delete-comment') {
        var commentId = target.getAttribute('data-comment-id');
        if (commentId && state.currentEditId) {
          if (confirm('Delete comment?')) {
            deleteComment(state.currentEditId, commentId, function(activity) {
              replaceActivityInState(activity);
              closeAllModals();
              showSuccessToast('Comment deleted');
            });
          }
        }
        return;
      }

      // Add comment button
      if (target.id === 'bk-add-comment-btn') {
        var textarea = document.getElementById('bk-new-comment-text');
        if (textarea && state.currentEditId && textarea.value.trim()) {
          addComment(state.currentEditId, textarea.value.trim(), function(activity) {
            replaceActivityInState(activity);
            closeAllModals();
            openActivityModal(activity.id);
            showSuccessToast('Comment added');
          });
        }
        return;
      }

      // New Task save
      if (target.id === 'bk-new-task-save') {
        saveNewTask();
        return;
      }

      // New Activity save
      if (target.id === 'bk-new-activity-save') {
        saveNewActivity();
        return;
      }
    });

    // Search inputs with debounce
    var tasksSearch = document.getElementById('bk-search-tasks');
    var activitiesSearch = document.getElementById('bk-search-activities');

    tasksSearch.addEventListener('input', debounce(function() {
      state.tasksSearch = tasksSearch.value;
      renderTasks();
    }, 200));

    activitiesSearch.addEventListener('input', debounce(function() {
      state.activitiesSearch = activitiesSearch.value;
      renderKanban();
    }, 200));

    // Settings modal save buttons (delegated)
    document.addEventListener('click', function(e) {
      var target = e.target;
      if (target.id === 'bk-settings-save-profile') {
        saveSettingsProfile();
        return;
      }
      if (target.id === 'bk-settings-save-notifications') {
        saveSettingsNotifications();
        return;
      }
      if (target.id === 'bk-settings-import') {
        importFromSpreadsheet();
        return;
      }
      if (target.id === 'bk-settings-export') {
        exportToSpreadsheet();
        return;
      }
      if (target.id === 'bk-settings-add-vacation') {
        addVacationRow();
        return;
      }
      if (target.id === 'bk-admin-save-list') {
        saveAdminList();
        return;
      }
      if (target.id === 'bk-admin-save-config') {
        saveAdminConfig();
        return;
      }
      if (target.id === 'bk-admin-delete-user') {
        deleteAdminUser();
        return;
      }
      if (target.id === 'bk-admin-import-snapshot') {
        importAdminSnapshot();
        return;
      }
    });

    // Close dropdown on outside click
    document.addEventListener('click', function(e) {
      var dropdown = document.getElementById('bk-user-dropdown');
      if (dropdown.classList.contains('bk-user-dropdown--open') && !e.target.closest('#bk-user-menu')) {
        dropdown.classList.remove('bk-user-dropdown--open');
      }
    });

    // Drag-and-drop on kanban
    setupDragDrop();
  }

  // ---------------------------------------------------------------
  // Drag & Drop (HTML5 DnD API)
  // ---------------------------------------------------------------
  var _dragData = null;

  function setupDragDrop() {
    var body = document.getElementById('bk-activities-body');

    body.addEventListener('dragstart', function(e) {
      var card = e.target.closest('.bk-activity-card');
      if (!card) return;
      var activityId = card.getAttribute('data-activity-id');
      var version = parseInt(card.getAttribute('data-version'), 10) || 1;
      _dragData = { id: activityId, version: version };
      card.classList.add('bk-activity-card--dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', activityId);
    });

    body.addEventListener('dragend', function(e) {
      var card = e.target.closest('.bk-activity-card');
      if (card) card.classList.remove('bk-activity-card--dragging');
      document.querySelectorAll('.bk-column__drop-zone--active').forEach(function(el) {
        el.classList.remove('bk-column__drop-zone--active');
      });
      document.querySelectorAll('.bk-column--drag-over').forEach(function(el) {
        el.classList.remove('bk-column--drag-over');
      });
    });

    body.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      var dropZone = e.target.closest('.bk-column__drop-zone');
      if (dropZone) {
        dropZone.classList.add('bk-column__drop-zone--active');
      }
      var column = e.target.closest('.bk-column');
      if (column) {
        column.classList.add('bk-column--drag-over');
      }
    });

    body.addEventListener('dragleave', function(e) {
      var dropZone = e.target.closest('.bk-column__drop-zone');
      if (dropZone) {
        dropZone.classList.remove('bk-column__drop-zone--active');
      }
      var column = e.target.closest('.bk-column');
      if (column) {
        column.classList.remove('bk-column--drag-over');
      }
    });

    body.addEventListener('drop', function(e) {
      e.preventDefault();
      document.querySelectorAll('.bk-column__drop-zone--active').forEach(function(el) {
        el.classList.remove('bk-column__drop-zone--active');
      });
      document.querySelectorAll('.bk-column--drag-over').forEach(function(el) {
        el.classList.remove('bk-column--drag-over');
      });

      if (!_dragData) return;

      var dropZone = e.target.closest('.bk-column__drop-zone');
      if (!dropZone) return;

      var columnId = dropZone.getAttribute('data-column-id');
      var newOrder = parseInt(dropZone.getAttribute('data-drop-index'), 10);

      if (!columnId || isNaN(newOrder)) return;

      // Optimistic UI: update state immediately
      var activity = findActivityById(_dragData.id);
      if (!activity) return;

      var oldColumnId = activity.columnId;
      var oldOrder = activity.columnOrder;

      // Update local state
      activity.columnId = columnId;
      activity.columnOrder = newOrder;

      // Re-render kanban
      renderKanban();

      // Send to server
      google.script.run
        .withSuccessHandler(function(result) {
          replaceActivityInState(result);
          showSuccessToast('Card moved');
        })
        .withFailureHandler(function(err) {
          // Revert optimistic update
          activity.columnId = oldColumnId;
          activity.columnOrder = oldOrder;
          renderKanban();
          showErrorToast('Could not move card: ' + (err.message || 'Error'));
        })
        .moveActivity(_dragData.id, columnId, newOrder, _dragData.version || 1);

      _dragData = null;
    });

    // Touch support for drag-and-drop
    var longPressTimer = null;
    var touchDragData = null;

    body.addEventListener('touchstart', function(e) {
      var card = e.target.closest('.bk-activity-card');
      if (!card) return;
      var touch = e.touches[0];
      longPressTimer = setTimeout(function() {
        card.classList.add('bk-activity-card--dragging');
        touchDragData = {
          id: card.getAttribute('data-activity-id'),
          version: parseInt(card.getAttribute('data-version'), 10) || 1,
          card: card,
          startX: touch.clientX,
          startY: touch.clientY
        };
      }, 200);
    }, { passive: true });

    body.addEventListener('touchmove', function(e) {
      if (!touchDragData) return;
      e.preventDefault();
      var touch = e.touches[0];
      touchDragData.card.style.position = 'fixed';
      touchDragData.card.style.zIndex = 9999;
      touchDragData.card.style.pointerEvents = 'none';
      touchDragData.card.style.left = (touch.clientX - 110) + 'px';
      touchDragData.card.style.top = (touch.clientY - 60) + 'px';

      // Highlight drop zone under finger
      var el = document.elementFromPoint(touch.clientX, touch.clientY);
      var dropZone = el ? el.closest('.bk-column__drop-zone') : null;
      document.querySelectorAll('.bk-column__drop-zone--active').forEach(function(dz) {
        dz.classList.remove('bk-column__drop-zone--active');
      });
      if (dropZone) dropZone.classList.add('bk-column__drop-zone--active');
    }, { passive: false });

    body.addEventListener('touchend', function(e) {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      if (!touchDragData) return;

      touchDragData.card.style.position = '';
      touchDragData.card.style.zIndex = '';
      touchDragData.card.style.pointerEvents = '';
      touchDragData.card.style.left = '';
      touchDragData.card.style.top = '';
      touchDragData.card.classList.remove('bk-activity-card--dragging');

      var touch = e.changedTouches[0];
      var el = document.elementFromPoint(touch.clientX, touch.clientY);
      var dropZone = el ? el.closest('.bk-column__drop-zone') : null;

      if (dropZone) {
        var columnId = dropZone.getAttribute('data-column-id');
        var newOrder = parseInt(dropZone.getAttribute('data-drop-index'), 10);
        if (columnId && !isNaN(newOrder)) {
          var activity = findActivityById(touchDragData.id);
          if (activity) {
            activity.columnId = columnId;
            activity.columnOrder = newOrder;
            renderKanban();
            google.script.run
              .withSuccessHandler(function(result) {
                replaceActivityInState(result);
              })
              .withFailureHandler(function(err) {
                // Re-render from server on failure
                showErrorToast('Could not move card');
                renderAll();
              })
              .moveActivity(touchDragData.id, columnId, newOrder, touchDragData.version);
          }
        }
      }

      document.querySelectorAll('.bk-column__drop-zone--active').forEach(function(dz) {
        dz.classList.remove('bk-column__drop-zone--active');
      });
      touchDragData = null;
    }, { passive: true });
  }

  // ---------------------------------------------------------------
  // API Wrappers
  // ---------------------------------------------------------------
  function findTaskById(id) {
    for (var i = 0; i < state.tasks.length; i++) {
      if (state.tasks[i].id === id) return state.tasks[i];
    }
    return null;
  }

  function findActivityById(id) {
    for (var i = 0; i < state.activities.length; i++) {
      if (state.activities[i].id === id) return state.activities[i];
    }
    return null;
  }

  function replaceActivityInState(updated) {
    for (var i = 0; i < state.activities.length; i++) {
      if (state.activities[i].id === updated.id) {
        state.activities[i] = updated;
        return;
      }
    }
  }

  function replaceTaskInState(updated) {
    for (var i = 0; i < state.tasks.length; i++) {
      if (state.tasks[i].id === updated.id) {
        state.tasks[i] = updated;
        return;
      }
    }
  }

  function getModalVersion(type) {
    var actionsId = type === 'task' ? 'bk-modal-task-actions' : 'bk-modal-activity-actions';
    var actions = document.getElementById(actionsId);
    var versionKey = type === 'task' ? 'taskVersion' : 'activityVersion';
    return parseInt(actions ? actions.dataset[versionKey] : 1, 10) || 1;
  }

  // Task API
  function completeTask(taskId, version, cb) {
    // Optimistic UI
    var task = findTaskById(taskId);
    if (task) {
      task.completedDate = new Date().toISOString();
      renderTasks();
    }

    google.script.run
      .withSuccessHandler(function(result) {
        replaceTaskInState(result);
        renderTasks();
        renderWelcome();
        if (cb) cb(result);
        showSuccessToast('Task completed');
      })
      .withFailureHandler(function(err) {
        if (task) { task.completedDate = null; renderTasks(); }
        showErrorToast(err.message || 'Could not complete task');
      })
      .completeTask(taskId);
  }

  function uncompleteTask(taskId, version, cb) {
    var task = findTaskById(taskId);
    if (task) {
      task.completedDate = null;
      renderTasks();
    }

    google.script.run
      .withSuccessHandler(function(result) {
        replaceTaskInState(result);
        renderTasks();
        renderWelcome();
        if (cb) cb(result);
      })
      .withFailureHandler(function(err) {
        if (task) { task.completedDate = new Date().toISOString(); renderTasks(); }
        showErrorToast(err.message || 'Could not uncomplete task');
      })
      .uncompleteTask(taskId);
  }

  function deleteTask(taskId, version, cb) {
    var task = findTaskById(taskId);
    if (task) {
      task.deletedDate = new Date().toISOString();
      renderTasks();
    }

    google.script.run
      .withSuccessHandler(function(result) {
        replaceTaskInState(result);
        if (cb) cb();
        showWarningToast('Task deleted', function() {
          undeleteTask(taskId, (result.version || 1) - 1);
        });
      })
      .withFailureHandler(function(err) {
        if (task) { task.deletedDate = null; renderTasks(); }
        showErrorToast(err.message || 'Could not delete task');
      })
      .deleteTask(taskId);
  }

  function undeleteTask(taskId, version, cb) {
    google.script.run
      .withSuccessHandler(function(result) {
        replaceTaskInState(result);
        renderTasks();
        if (cb) cb();
      })
      .withFailureHandler(function(err) {
        showErrorToast(err.message || 'Could not undelete task');
      })
      .undeleteTask(taskId);
  }

  function saveTaskFromModal() {
    var taskId = state.currentEditId;
    if (!taskId) return;

    var version = getModalVersion('task');
    var changes = {};
    var hasChanges = false;
    Object.keys(state._modifiedFields).forEach(function(field) {
      changes[field] = state._modifiedFields[field];
      hasChanges = true;
    });

    // Also check direct field values
    var body = document.getElementById('bk-modal-task-body');
    if (!hasChanges) {
      body.querySelectorAll('[data-field]').forEach(function(el) {
        var field = el.dataset.field;
        var value = el.type === 'date' ? (el.value || null) : el.value;
        if (value === '' && field !== 'description') value = null;
        changes[field] = value;
      });
    }

    changes.version = version;

    google.script.run
      .withSuccessHandler(function(result) {
        replaceTaskInState(result);
        closeAllModals();
        renderTasks();
        renderWelcome();
        showSuccessToast('Task updated');
      })
      .withFailureHandler(function(err) {
        if (err.code === 409) {
          showWarningToast('Modified by another user. Reloading…', function() {
            openTaskModal(taskId);
          });
          // Re-fetch the task
          google.script.run
            .withSuccessHandler(function(freshTask) {
              replaceTaskInState(freshTask);
              renderTasks();
              openTaskModal(taskId);
            })
            .withFailureHandler(function() {})
            .getTask(taskId);
        } else {
          showErrorToast(err.message || 'Could not update task');
        }
      })
      .updateTask(taskId, changes);
  }

  // Activity API
  function completeActivity(id, version, cb) {
    google.script.run
      .withSuccessHandler(function(result) {
        replaceActivityInState(result);
        renderKanban();
        if (cb) cb();
        showSuccessToast('Activity completed');
      })
      .withFailureHandler(function(err) {
        showErrorToast(err.message || 'Could not complete activity');
      })
      .completeActivity(id);
  }

  function uncompleteActivity(id, version, cb) {
    google.script.run
      .withSuccessHandler(function(result) {
        replaceActivityInState(result);
        renderKanban();
        if (cb) cb();
      })
      .withFailureHandler(function(err) {
        showErrorToast(err.message || 'Could not uncomplete activity');
      })
      .uncompleteActivity(id);
  }

  function deleteActivity(id, version, cb) {
    google.script.run
      .withSuccessHandler(function(result) {
        replaceActivityInState(result);
        renderKanban();
        if (cb) cb();
        showWarningToast('Activity deleted', function() {
          undeleteActivity(id, (result.version || 1) - 1);
        });
      })
      .withFailureHandler(function(err) {
        showErrorToast(err.message || 'Could not delete activity');
      })
      .deleteActivity(id);
  }

  function undeleteActivity(id, version, cb) {
    google.script.run
      .withSuccessHandler(function(result) {
        replaceActivityInState(result);
        renderKanban();
        if (cb) cb();
      })
      .withFailureHandler(function(err) {
        showErrorToast(err.message || 'Could not undelete activity');
      })
      .undeleteActivity(id);
  }

  function saveActivityFromModal() {
    var activityId = state.currentEditId;
    if (!activityId) return;

    var version = getModalVersion('activity');
    var changes = {};
    var hasChanges = false;
    Object.keys(state._modifiedFields).forEach(function(field) {
      changes[field] = state._modifiedFields[field];
      hasChanges = true;
    });

    var body = document.getElementById('bk-modal-activity-body');
    if (!hasChanges) {
      body.querySelectorAll('[data-field]').forEach(function(el) {
        var field = el.dataset.field;
        var value = el.type === 'date' ? (el.value || null) : el.value;
        if (value === '' && field !== 'title') value = null;
        changes[field] = value;
      });
    }

    changes.version = version;

    google.script.run
      .withSuccessHandler(function(result) {
        replaceActivityInState(result);
        closeAllModals();
        renderKanban();
        showSuccessToast('Activity updated');
      })
      .withFailureHandler(function(err) {
        if (err.code === 409) {
          showWarningToast('Modified by another user. Reloading…');
          google.script.run
            .withSuccessHandler(function(fresh) {
              replaceActivityInState(fresh);
              renderKanban();
              openActivityModal(activityId);
            })
            .withFailureHandler(function() {})
            .getActivity(activityId);
        } else {
          showErrorToast(err.message || 'Could not update activity');
        }
      })
      .updateActivity(activityId, changes);
  }

  // Comment API
  function addComment(activityId, text, cb) {
    google.script.run
      .withSuccessHandler(cb)
      .withFailureHandler(function(err) {
        showErrorToast(err.message || 'Could not add comment');
      })
      .addComment(activityId, text);
  }

  function updateComment(activityId, commentId, newText, cb) {
    google.script.run
      .withSuccessHandler(cb)
      .withFailureHandler(function(err) {
        showErrorToast(err.message || 'Could not update comment');
      })
      .updateComment(activityId, commentId, newText);
  }

  function deleteComment(activityId, commentId, cb) {
    google.script.run
      .withSuccessHandler(cb)
      .withFailureHandler(function(err) {
        showErrorToast(err.message || 'Could not delete comment');
      })
      .deleteComment(activityId, commentId);
  }

  // ---------------------------------------------------------------
  // Create New Task / Activity
  // ---------------------------------------------------------------
  function openNewTaskModal() {
    populateUserDropdown('bk-new-task-assignee');
    document.getElementById('bk-new-task-desc').value = '';
    document.getElementById('bk-new-task-due').value = '';
    document.getElementById('bk-new-task-assignee').value = '';
    document.getElementById('bk-new-task-visibility').value = 'private';
    document.getElementById('bk-new-task-comment').value = '';
    document.getElementById('bk-modal-new-task').classList.add('bk-modal-overlay--open');
  }

  function saveNewTask() {
    var desc = document.getElementById('bk-new-task-desc').value.trim();
    if (!desc) {
      showErrorToast('Description is required');
      return;
    }

    var data = {
      description: desc,
      dueDate: document.getElementById('bk-new-task-due').value || null,
      assignedTo: document.getElementById('bk-new-task-assignee').value || null,
      visibility: document.getElementById('bk-new-task-visibility').value || 'private',
      comment: document.getElementById('bk-new-task-comment').value.trim() || null
    };

    // Optimistic: add to local state (will be replaced by server response)
    google.script.run
      .withSuccessHandler(function(task) {
        state.tasks.push(task);
        closeAllModals();
        renderTasks();
        renderWelcome();
        showSuccessToast('Task created');
      })
      .withFailureHandler(function(err) {
        showErrorToast(err.message || 'Could not create task');
      })
      .createTask(data);
  }

  function openNewActivityModal() {
    populateUserDropdown('bk-new-activity-assignee');
    document.getElementById('bk-new-activity-title').value = '';
    document.getElementById('bk-new-activity-desc').value = '';
    document.getElementById('bk-new-activity-due').value = '';
    document.getElementById('bk-new-activity-assignee').value = '';
    document.getElementById('bk-modal-new-activity').classList.add('bk-modal-overlay--open');
  }

  function saveNewActivity() {
    var title = document.getElementById('bk-new-activity-title').value.trim();
    if (!title) {
      showErrorToast('Title is required');
      return;
    }

    var data = {
      title: title,
      description: document.getElementById('bk-new-activity-desc').value.trim() || null,
      dueDate: document.getElementById('bk-new-activity-due').value || null,
      assignedTo: document.getElementById('bk-new-activity-assignee').value || null
    };

    google.script.run
      .withSuccessHandler(function(activity) {
        state.activities.push(activity);
        closeAllModals();
        renderKanban();
        renderWelcome();
        showSuccessToast('Activity created');
      })
      .withFailureHandler(function(err) {
        showErrorToast(err.message || 'Could not create activity');
      })
      .createActivity(data);
  }

  function populateUserDropdown(selectId) {
    var select = document.getElementById(selectId);
    if (!select) return;
    var currentVal = select.value;
    select.innerHTML = '<option value="">— Unassigned —</option>';
    for (var i = 0; i < state.allUsers.length; i++) {
      var u = state.allUsers[i];
      select.innerHTML += '<option value="' + escapeHtml(u.email) + '">' + escapeHtml(u.displayName || u.email) + '</option>';
    }
    select.value = currentVal;
  }

  // ---------------------------------------------------------------
  // Settings Modal
  // ---------------------------------------------------------------
  function openSettingsModal() {
    var body = document.getElementById('bk-modal-settings-body');
    if (!state.user) return;

    var settings = state.user.settings || {};
    var webhookUrl = settings.chatWebhookUrl || '';
    var vacations = settings.vacations || [];

    var vacationHtml = '';
    for (var i = 0; i < vacations.length; i++) {
      vacationHtml +=
        '<div class="bk-vacation-row">' +
          '<input type="date" class="bk-vacation-start" value="' + (vacations[i].start || '') + '">' +
          '<span>to</span>' +
          '<input type="date" class="bk-vacation-end" value="' + (vacations[i].end || '') + '">' +
          '<button class="bk-btn bk-btn--danger bk-btn--sm" data-action="remove-vacation">✕</button>' +
        '</div>';
    }

    body.innerHTML =
      '<div class="bk-section">' +
        '<div class="bk-section__title">Profile</div>' +
        '<div class="bk-field">' +
          '<label class="bk-field__label">Email</label>' +
          '<div class="bk-field__meta">' + escapeHtml(state.user.email) + '</div>' +
        '</div>' +
        '<div class="bk-field">' +
          '<label class="bk-field__label">Display name</label>' +
          '<input class="bk-field__input" type="text" id="bk-settings-display-name" value="' + escapeHtml(state.user.displayName || '') + '">' +
        '</div>' +
        '<button class="bk-btn bk-btn--primary" id="bk-settings-save-profile">Save</button>' +
      '</div>' +
      '<div class="bk-section">' +
        '<div class="bk-section__title">Notifications</div>' +
        '<div class="bk-field">' +
          '<label class="bk-field__label">Google Chat Webhook URL</label>' +
          '<input class="bk-field__input" type="text" id="bk-settings-webhook" value="' + escapeHtml(webhookUrl) + '" placeholder="https://chat.googleapis.com/v1/spaces/...">' +
        '</div>' +
        '<div class="bk-field">' +
          '<label class="bk-field__label">Vacation Periods</label>' +
          '<div id="bk-vacation-list">' + vacationHtml + '</div>' +
          '<button class="bk-btn bk-btn--secondary bk-btn--sm bk-mt-sm" id="bk-settings-add-vacation">+ Add period</button>' +
        '</div>' +
        '<button class="bk-btn bk-btn--primary bk-mt-sm" id="bk-settings-save-notifications">Save</button>' +
      '</div>' +
      '<div class="bk-section">' +
        '<div class="bk-section__title">Import / Export</div>' +
        '<div class="bk-field">' +
          '<label class="bk-field__label">Spreadsheet ID</label>' +
          '<input class="bk-field__input" type="text" id="bk-settings-sheet-id" placeholder="Enter spreadsheet ID">' +
        '</div>' +
        '<div class="bk-flex bk-flex--gap">' +
          '<button class="bk-btn bk-btn--primary" id="bk-settings-import">Import</button>' +
          '<button class="bk-btn bk-btn--secondary" id="bk-settings-export">Generate Export</button>' +
        '</div>' +
      '</div>';

    document.getElementById('bk-modal-settings').classList.add('bk-modal-overlay--open');
  }

  function saveSettingsProfile() {
    var displayName = document.getElementById('bk-settings-display-name').value.trim();
    if (!displayName) {
      showErrorToast('Display name is required');
      return;
    }
    google.script.run
      .withSuccessHandler(function(user) {
        state.user = user;
        updateTopBar();
        renderWelcome();
        showSuccessToast('Profile updated');
      })
      .withFailureHandler(function(err) {
        showErrorToast(err.message || 'Could not update profile');
      })
      .updateProfile(displayName);
  }

  function saveSettingsNotifications() {
    var webhook = document.getElementById('bk-settings-webhook').value.trim();

    // Collect vacation periods
    var vacationList = document.getElementById('bk-vacation-list');
    var rows = vacationList.querySelectorAll('.bk-vacation-row');
    var vacations = [];
    for (var i = 0; i < rows.length; i++) {
      var start = rows[i].querySelector('.bk-vacation-start').value;
      var end = rows[i].querySelector('.bk-vacation-end').value;
      if (start && end) {
        vacations.push({ start: start, end: end });
      }
    }

    // Save webhook
    google.script.run
      .withSuccessHandler(function() {
        showSuccessToast('Webhook URL saved');
        // Save vacations
        google.script.run
          .withSuccessHandler(function() {
            showSuccessToast('Vacation periods saved');
          })
          .withFailureHandler(function(err) {
            showErrorToast(err.message || 'Could not save vacations');
          })
          .saveVacations(vacations);
      })
      .withFailureHandler(function(err) {
        showErrorToast(err.message || 'Could not save webhook URL');
      })
      .saveChatWebhook(webhook);
  }

  function addVacationRow() {
    var list = document.getElementById('bk-vacation-list');
    var row = document.createElement('div');
    row.className = 'bk-vacation-row';
    row.innerHTML =
      '<input type="date" class="bk-vacation-start">' +
      '<span>to</span>' +
      '<input type="date" class="bk-vacation-end">' +
      '<button class="bk-btn bk-btn--danger bk-btn--sm" data-action="remove-vacation">✕</button>';
    list.appendChild(row);

    row.querySelector('[data-action="remove-vacation"]').addEventListener('click', function() {
      row.parentNode.removeChild(row);
    });
  }

  function importFromSpreadsheet() {
    var sheetId = document.getElementById('bk-settings-sheet-id').value.trim();
    if (!sheetId) {
      showErrorToast('Spreadsheet ID is required');
      return;
    }
    google.script.run
      .withSuccessHandler(function(result) {
        showInfoToast('Import complete. ' + (result.tasksImported || 0) + ' tasks imported, ' +
          (result.tasksSkipped || 0) + ' skipped. ' +
          (result.activitiesImported || 0) + ' activities imported, ' +
          (result.activitiesSkipped || 0) + ' skipped.' +
          ((result.errors || 0) > 0 ? ' ' + result.errors + ' rows had errors.' : ''));
        // Refresh data
        refreshFromServer();
      })
      .withFailureHandler(function(err) {
        showErrorToast(err.message || 'Import failed');
      })
      .importFromSpreadsheet(sheetId);
  }

  function exportToSpreadsheet() {
    google.script.run
      .withSuccessHandler(function(result) {
        showInfoToast('Export ready in spreadsheet: ' + result.sheetId);
      })
      .withFailureHandler(function(err) {
        showErrorToast(err.message || 'Export failed');
      })
      .exportToSpreadsheet();
  }

  // ---------------------------------------------------------------
  // Admin Modal
  // ---------------------------------------------------------------
  function openAdminModal() {
    var body = document.getElementById('bk-modal-admin-body');

    body.innerHTML = '<div class="bk-text-muted">Loading admin panel…</div>';
    document.getElementById('bk-modal-admin').classList.add('bk-modal-overlay--open');

    // Fetch admin data asynchronously
    var adminListHtml = '';
    google.script.run
      .withSuccessHandler(function(list) {
        adminListHtml = escapeHtml(list || '');

        google.script.run
          .withSuccessHandler(function(configStr) {
            google.script.run
              .withSuccessHandler(function(snapshots) {
                renderAdminPanel(body, adminListHtml, configStr, snapshots);
              })
              .withFailureHandler(function() { renderAdminPanel(body, adminListHtml, configStr, []); })
              .getAvailableSnapshots();
          })
          .withFailureHandler(function(err) {
            renderAdminPanel(body, adminListHtml, '{}', []);
          })
          .getConfig();
      })
      .withFailureHandler(function(err) {
        showErrorToast(err.message || 'Could not load admin data');
      })
      .getAdminList();
  }

  function renderAdminPanel(body, adminListHtml, configStr, snapshots) {
    var snapshotOptions = '';
    if (snapshots && snapshots.length > 0) {
      for (var i = 0; i < snapshots.length; i++) {
        snapshotOptions += '<option value="' + escapeHtml(snapshots[i]) + '">' + escapeHtml(snapshots[i]) + '</option>';
      }
    } else {
      snapshotOptions = '<option value="">No snapshots available</option>';
    }

    body.innerHTML =
      '<div class="bk-section">' +
        '<div class="bk-section__title">Admin Emails</div>' +
        '<div class="bk-field">' +
          '<textarea class="bk-field__textarea" id="bk-admin-emails" style="min-height:50px;">' + adminListHtml + '</textarea>' +
          '<div class="bk-field__meta">Semicolon-separated email addresses</div>' +
        '</div>' +
        '<button class="bk-btn bk-btn--primary" id="bk-admin-save-list">Save</button>' +
      '</div>' +
      '<div class="bk-section">' +
        '<div class="bk-section__title">Configuration</div>' +
        '<div class="bk-field">' +
          '<textarea class="bk-config-editor" id="bk-admin-config">' + escapeHtml(configStr) + '</textarea>' +
        '</div>' +
        '<button class="bk-btn bk-btn--primary" id="bk-admin-save-config">Save Config</button>' +
      '</div>' +
      '<div class="bk-section">' +
        '<div class="bk-section__title">Delete User</div>' +
        '<div class="bk-field__row">' +
          '<div class="bk-field" style="flex:2;">' +
            '<select class="bk-field__select" id="bk-admin-user-select">' +
              '<option value="">— Select user —</option>' +
              buildUserOptions('') +
            '</select>' +
          '</div>' +
          '<div class="bk-field">' +
            '<button class="bk-btn bk-btn--danger" id="bk-admin-delete-user">Delete User</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="bk-section">' +
        '<div class="bk-section__title">Import Snapshot</div>' +
        '<div class="bk-field__row">' +
          '<div class="bk-field">' +
            '<select class="bk-field__select" id="bk-admin-snapshot-date">' + snapshotOptions + '</select>' +
          '</div>' +
          '<div class="bk-field">' +
            '<select class="bk-field__select" id="bk-admin-snapshot-mode">' +
              '<option value="merge">Merge</option>' +
              '<option value="overwrite">Overwrite</option>' +
            '</select>' +
          '</div>' +
          '<div class="bk-field">' +
            '<button class="bk-btn bk-btn--primary" id="bk-admin-import-snapshot">Import</button>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  function saveAdminList() {
    var list = document.getElementById('bk-admin-emails').value;
    google.script.run
      .withSuccessHandler(function() {
        showSuccessToast('Admin list saved');
      })
      .withFailureHandler(function(err) {
        showErrorToast(err.message || 'Could not save admin list');
      })
      .saveAdminList(list);
  }

  function saveAdminConfig() {
    var json = document.getElementById('bk-admin-config').value;
    google.script.run
      .withSuccessHandler(function() {
        showSuccessToast('Config saved. Reloading…');
        refreshFromServer();
      })
      .withFailureHandler(function(err) {
        showErrorToast(err.message || 'Could not save config: ' + (err.message || ''));
      })
      .saveConfig(json);
  }

  function deleteAdminUser() {
    var select = document.getElementById('bk-admin-user-select');
    var email = select.value;
    if (!email) {
      showErrorToast('Please select a user');
      return;
    }
    if (!confirm('Are you sure you want to delete this user? All their private tasks will be permanently removed. A spreadsheet dump will be generated before deletion.')) {
      return;
    }
    google.script.run
      .withSuccessHandler(function(result) {
        showInfoToast('User deleted. Dump created: ' + (result.dumpSheetName || ''));
        refreshFromServer();
      })
      .withFailureHandler(function(err) {
        showErrorToast(err.message || 'Could not delete user');
      })
      .deleteUser(email);
  }

  function importAdminSnapshot() {
    var dateSelect = document.getElementById('bk-admin-snapshot-date');
    var modeSelect = document.getElementById('bk-admin-snapshot-mode');
    var date = dateSelect.value;
    var mode = modeSelect.value;

    if (!date) {
      showErrorToast('No snapshot selected');
      return;
    }
    if (!confirm('Import snapshot from ' + date + ' in [' + mode + '] mode? A revert dump will be created before proceeding.')) {
      return;
    }

    google.script.run
      .withSuccessHandler(function(result) {
        showInfoToast('Snapshot imported. ' + (result.imported || 0) + ' records. Revert dump: ' + (result.revertSheet || ''));
        refreshFromServer();
      })
      .withFailureHandler(function(err) {
        showErrorToast(err.message || 'Could not import snapshot');
      })
      .importSnapshot(date, mode);
  }

  // ---------------------------------------------------------------
  // Pane Toggles
  // ---------------------------------------------------------------
  function togglePane(pane) {
    var paneEl = document.getElementById('bk-pane-' + pane);
    var btn = document.getElementById('bk-toggle-' + pane);
    if (pane === 'tasks') {
      state.tasksPaneHidden = !state.tasksPaneHidden;
      paneEl.classList.toggle('bk-pane--hidden');
      btn.textContent = state.tasksPaneHidden ? '▶ Show' : '◀ Hide';
    } else {
      state.activitiesPaneHidden = !state.activitiesPaneHidden;
      paneEl.classList.toggle('bk-pane--hidden');
      btn.textContent = state.activitiesPaneHidden ? '▶ Show' : '◀ Hide';
    }
  }

  // ---------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------
  function startPolling() {
    var interval = (state.config && state.config.ui && state.config.ui.pollingIntervalSeconds) || 10;
    if (state.pollInterval) clearInterval(state.pollInterval);
    state.pollInterval = setInterval(function() {
      google.script.run
        .withSuccessHandler(function(response) {
          state.pollFailures = 0;
          document.getElementById('bk-error-banner').classList.remove('bk-error-banner--visible');
          if (response.changed && response.data) {
            state.tasks = response.data.tasks || [];
            state.activities = response.data.activities || [];
            state.columns = (response.data.config && response.data.config.kanban && response.data.config.kanban.columns) || [];
            state.config = response.data.config || state.config;
            if (response.newVersion !== undefined) state.dbVersion = response.newVersion;
            renderAll();
          }
        })
        .withFailureHandler(function() {
          state.pollFailures++;
          if (state.pollFailures >= 3) {
            document.getElementById('bk-error-banner').classList.add('bk-error-banner--visible');
          }
        })
        .poll(state.dbVersion);
    }, interval * 1000);
  }

  function refreshFromServer() {
    google.script.run
      .withSuccessHandler(function(data) {
        state.user = data.user;
        state.tasks = data.tasks || [];
        state.activities = data.activities || [];
        state.columns = (data.config && data.config.kanban && data.config.kanban.columns) || [];
        state.config = data.config || state.config;
        state.dbVersion = data.dbVersion || 0;
        renderAll();
        showSuccessToast('Data refreshed');
      })
      .withFailureHandler(function(err) {
        showErrorToast('Could not refresh: ' + (err.message || 'Error'));
      })
      .getInitialData();
  }

  // ---------------------------------------------------------------
  // Keyboard Shortcuts
  // ---------------------------------------------------------------
  function setupKeyboardShortcuts() {
    document.addEventListener('keydown', function(e) {
      // Escape closes modal
      if (e.key === 'Escape') {
        var openModal = document.querySelector('.bk-modal-overlay--open');
        if (openModal) {
          closeAllModals();
          return;
        }
        // Close user dropdown
        document.getElementById('bk-user-dropdown').classList.remove('bk-user-dropdown--open');
      }

      // Only when no input is focused
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

      // Ctrl+N = new task
      if (e.ctrlKey && e.key === 'n') {
        e.preventDefault();
        openNewTaskModal();
      }
      // Ctrl+Shift+N = new activity
      if (e.ctrlKey && e.shiftKey && e.key === 'N') {
        e.preventDefault();
        openNewActivityModal();
      }
      // / = focus search
      if (e.key === '/') {
        e.preventDefault();
        var tasksSearch = document.getElementById('bk-search-tasks');
        if (tasksSearch && !state.tasksPaneHidden) {
          tasksSearch.focus();
        }
      }
    });
  }

  // ---------------------------------------------------------------
  // Close Session
  // ---------------------------------------------------------------
  function closeSession() {
    state = {
      user: null, tasks: [], activities: [], columns: [], config: {},
      dbVersion: 0, tasksSearch: '', activitiesSearch: '',
      showCompletedTasks: false, showDeletedTasks: false,
      showCompletedActivities: false, showDeletedActivities: false,
      tasksPaneHidden: false, activitiesPaneHidden: false,
      loading: false, pollFailures: 0, pollInterval: null,
      currentEditId: null, currentEditType: null,
      allUsers: [], _modifiedFields: {}
    };
    if (state.pollInterval) clearInterval(state.pollInterval);
    location.reload();
  }

  // ---------------------------------------------------------------
  // Utility Functions
  // ---------------------------------------------------------------
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDate(isoString) {
    if (!isoString) return '—';
    var parts = isoString.split('T');
    var datePart = parts[0];
    var timePart = parts[1] ? parts[1].substring(0, 5) : '';
    return datePart + (timePart ? ' ' + timePart : '');
  }

  function debounce(fn, delay) {
    var timer = null;
    return function() {
      var args = arguments;
      var ctx = this;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function() {
        fn.apply(ctx, args);
        timer = null;
      }, delay);
    };
  }
</script>
