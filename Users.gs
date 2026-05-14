// ============================================================
// Users.gs -- User registration, lookup, admin check,
//            display name derivation, settings update
// ============================================================

// -------------------------------------------------------
// Display Name Derivation from Email
// -------------------------------------------------------
// Email local part  ->  split by "."   ->  first segment = first name
//                                       ->  second segment = last name
//   each segment split by "-", take first element, capitalize first letter.
//
// Examples:
//   peter-simon.hanson-muffin  ->  "Peter Hanson"
//   klaus.jansen               ->  "Klaus Jansen"
//   marie.curie-sklodowska     ->  "Marie Curie"
// -------------------------------------------------------

function deriveDisplayName(email) {
  if (!email) return '';
  var localPart = email.split('@')[0] || '';
  var parts = localPart.split('.');
  var firstNameRaw = parts[0] || '';
  var lastNameRaw = parts[1] || '';

  function cleanSegment(raw) {
    if (!raw) return '';
    var first = raw.split('-')[0];
    if (!first) return '';
    return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  }

  var firstName = cleanSegment(firstNameRaw);
  var lastName = lastNameRaw ? cleanSegment(lastNameRaw) : '';

  return (firstName + ' ' + lastName).trim();
}

// -------------------------------------------------------
// Admin Check
// -------------------------------------------------------

function isAdmin(email) {
  if (!email) {
    try { email = Session.getActiveUser().getEmail(); } catch (e) { return false; }
  }
  var adminListStr = PropertiesService.getScriptProperties().getProperty('admin') || '';
  var adminEmails = adminListStr.split(';').map(function(s) { return s.trim(); }).filter(Boolean);
  return adminEmails.indexOf(email) !== -1;
}

// -------------------------------------------------------
// Registration / Login
// -------------------------------------------------------

function registerUser(email) {
  if (!email) return null;
  var users = loadUsers();
  var existing = null;
  for (var i = 0; i < users.length; i++) {
    if (users[i].email === email) {
      existing = users[i];
      break;
    }
  }

  if (existing) {
    if (existing.deletedDate) {
      throw new Error('Your account has been deleted.');
    }
    existing.lastAccessDate = new Date().toISOString();
    existing.role = isAdmin(email) ? 'admin' : 'user';
    users[i] = existing;
    saveUsers(users);
    return existing;
  }

  var role = isAdmin(email) ? 'admin' : 'user';
  var newUser = {
    email: email,
    displayName: deriveDisplayName(email),
    firstAccessDate: new Date().toISOString(),
    lastAccessDate: new Date().toISOString(),
    role: role,
    deletedDate: null,
    settings: {}
  };

  users.push(newUser);
  saveUsers(users);
  try { purgeIfNeeded(); } catch (e) {}
  return newUser;
}

// -------------------------------------------------------
// Lookup
// -------------------------------------------------------

function getUser(email) {
  var users = loadUsers();
  for (var i = 0; i < users.length; i++) {
    if (users[i].email === email) return users[i];
  }
  return null;
}

function getDisplayName(email) {
  if (email === '_deleted_') return 'Deleted User';
  var user = getUser(email);
  return user ? user.displayName : email;
}

function getAllUsers() {
  var users = loadUsers();
  return users.filter(function(u) { return !u.deletedDate; });
}

// -------------------------------------------------------
// Settings Update
// -------------------------------------------------------

function updateUserSettings(email, settings) {
  var users = loadUsers();
  for (var i = 0; i < users.length; i++) {
    if (users[i].email === email) {
      if (settings.chatWebhookUrl !== undefined) {
        users[i].settings.chatWebhookUrl = settings.chatWebhookUrl;
      }
      if (settings.vacations !== undefined) {
        users[i].settings.vacations = settings.vacations;
      }
      if (settings.displayName !== undefined) {
        users[i].displayName = settings.displayName;
      }
      users[i].lastAccessDate = new Date().toISOString();
      saveUsers(users);
      try { purgeIfNeeded(); } catch (e) {}
      return users[i];
    }
  }
  throw new Error('User not found');
}
