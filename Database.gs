function setupSystem() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Open this script from a Google Sheet before running setupSystem().');
  PropertiesService.getScriptProperties().setProperty(QB.PROP_SPREADSHEET_ID, ss.getId());

  Object.keys(QB.HEADERS).forEach(function(name) {
    ensureSheet_(ss, name, QB.HEADERS[name]);
  });
  removeRetiredPinSystem_();

  seedSettings_();
  seedMembers_();
  seedTemplates_();
  applyValidations_();
  createAutomationTriggers();
  ss.setActiveSheet(ss.getSheetByName(QB.SHEETS.SETTINGS));
  SpreadsheetApp.flush();
  return { spreadsheetId: ss.getId(), spreadsheetUrl: ss.getUrl() };
}

/**
 * Run after installation or an OAuth scope change. This touches each Google
 * service used by the CRM so authorization can be completed before members
 * open the deployed web app.
 */
function authorizeSystem() {
  const db = getDb_();
  const result = {
    spreadsheetId: db.getId(),
    gmailApiAccount: Gmail.Users.getProfile('me').emailAddress,
    gmailAccessConfirmed: GmailApp.getInboxThreads(0, 1).length >= 0,
    driveAccessConfirmed: Boolean(DriveApp.getFileById(db.getId()).getName()),
    authorizedAt: new Date().toISOString()
  };
  console.log(JSON.stringify(result));
  return result;
}

function getDb_() {
  const id = PropertiesService.getScriptProperties().getProperty(QB.PROP_SPREADSHEET_ID);
  if (id) return SpreadsheetApp.openById(id);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('Database is not configured. Run setupSystem() from the bound Google Sheet.');
  PropertiesService.getScriptProperties().setProperty(QB.PROP_SPREADSHEET_ID, active.getId());
  return active;
}

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  const currentWidth = Math.max(1, sheet.getLastColumn());
  let currentHeaders = sheet.getRange(1, 1, 1, currentWidth).getValues()[0].map(function(value) { return String(value || ''); });
  const hasExistingSchema = currentHeaders.some(function(header) { return Boolean(header); });
  if (!hasExistingSchema) {
    if (sheet.getMaxColumns() < headers.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    currentHeaders = headers.slice();
  } else {
    headers.forEach(function(header) {
      if (currentHeaders.indexOf(header) >= 0) return;
      const nextColumn = currentHeaders.length + 1;
      if (sheet.getMaxColumns() < nextColumn) sheet.insertColumnAfter(sheet.getMaxColumns());
      sheet.getRange(1, nextColumn).setValue(header);
      currentHeaders.push(header);
    });
  }
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, currentHeaders.length)
    .setBackground('#15336f')
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setVerticalAlignment('middle');
  sheet.setRowHeight(1, 32);
  sheet.getDataRange().setFontFamily('Arial');
  if (!sheet.getFilter() && sheet.getMaxRows() > 1) {
    sheet.getRange(1, 1, Math.max(2, sheet.getLastRow()), currentHeaders.length).createFilter();
  }
  currentHeaders.forEach(function(header, index) {
    const width = /HtmlBody|DetailsJson|Notes|Summary|MatchReasons/.test(header) ? 260 :
      /Name|Email|Website|Subject|Device/.test(header) ? 180 : 125;
    sheet.setColumnWidth(index + 1, width);
  });
  const dateColumns = currentHeaders.reduce(function(list, header, index) {
    if (/At$|Date$|ExpiresAt$/.test(header)) list.push(index + 1);
    return list;
  }, []);
  dateColumns.forEach(function(col) {
    sheet.getRange(2, col, Math.max(1, sheet.getMaxRows() - 1), 1).setNumberFormat('yyyy-mm-dd hh:mm');
  });
  return sheet;
}

function removeRetiredPinSystem_() {
  const properties = PropertiesService.getScriptProperties();
  properties.deleteProperty('QB_ALLOW_EMERGENCY_PIN_RESET');
  properties.deleteProperty('QB_NEW_ADMIN_PIN');
  const retiredBySheet = {};
  retiredBySheet[QB.SHEETS.MEMBERS] = ['PinSalt', 'PinHash', 'FailedPinAttempts', 'PinLockedUntil', 'LastLoginAt'];
  retiredBySheet[QB.SHEETS.SESSIONS] = ['AuthTokenHash', 'AuthExpiresAt'];
  Object.keys(retiredBySheet).forEach(function(sheetName) {
    const sheet = getDb_().getSheetByName(sheetName);
    if (!sheet || !sheet.getLastColumn()) return;
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
    retiredBySheet[sheetName].map(function(header) { return headers.indexOf(header) + 1; })
      .filter(function(column) { return column > 0; })
      .sort(function(a, b) { return b - a; })
      .forEach(function(column) { sheet.deleteColumn(column); });
  });
  const oldSessionSetting = recordById_(QB.SHEETS.SETTINGS, 'Key', 'SessionHours');
  if (oldSessionSetting && oldSessionSetting._row) getDb_().getSheetByName(QB.SHEETS.SETTINGS).deleteRow(oldSessionSetting._row);
}

function seedSettings_() {
  const existing = records_(QB.SHEETS.SETTINGS);
  const defaults = [
    { Key: 'CampaignId', Value: uuid_('CAM'), Description: 'Permanent ID for the current campaign' },
    { Key: 'CampaignName', Value: '全辩 Sponsorship Campaign', Description: 'Name shown in the CRM' },
    { Key: 'SenderName', Value: '全辩 Marketing', Description: 'Display name used for outgoing emails' },
    { Key: 'BrandLogoAssetId', Value: '', Description: 'Email Asset used as the CRM interface logo' },
    { Key: 'FirstFollowUpBusinessDays', Value: '5', Description: 'Working days after the first email' },
    { Key: 'LaterFollowUpBusinessDays', Value: '7', Description: 'Working days after later follow-ups' },
    { Key: 'ReservationDays', Value: '3', Description: 'Days before an unused company reservation expires' },
    { Key: 'DailySendSafetyLimit', Value: '450', Description: 'CRM safety cap below the normal personal Gmail ceiling' },
    { Key: 'QueueBatchSize', Value: '20', Description: 'Maximum queued messages processed in one execution' },
    { Key: 'LastQueueRunAt', Value: '', Description: 'Updated automatically by the scheduler' },
    { Key: 'LastReplySyncAt', Value: '', Description: 'Updated after every completed Gmail reply scan' },
    { Key: 'Timezone', Value: 'Asia/Kuala_Lumpur', Description: 'Reporting timezone' }
  ];
  const existingKeys = new Set(existing.map(function(row) { return row.Key; }));
  appendRows_(QB.SHEETS.SETTINGS, defaults.filter(function(row) { return !existingKeys.has(row.Key); }));
  const legacyLimit = existing.find(function(row) { return row.Key === 'DailySendSafetyLimit'; });
  if (legacyLimit && String(legacyLimit.Value) === '90' && /consumer Gmail account/i.test(safeString_(legacyLimit.Description))) {
    updateById_(QB.SHEETS.SETTINGS, 'Key', 'DailySendSafetyLimit', { Value: '450', Description: 'CRM safety cap below the normal personal Gmail ceiling' });
  }
}

function seedMembers_() {
  if (records_(QB.SHEETS.MEMBERS).length) return;
  appendRows_(QB.SHEETS.MEMBERS, [{
    MemberId: uuid_('MBR'),
    MemberName: 'Marketing Administrator',
    Role: 'Admin',
    Active: true,
    CreatedAt: now_()
  }]);
}

function seedTemplates_() {
  if (records_(QB.SHEETS.TEMPLATES).length) return;
  appendRows_(QB.SHEETS.TEMPLATES, [
    {
      TemplateId: uuid_('TPL'),
      Name: 'First Approach',
      Type: 'First Approach',
      Subject: 'Sponsorship Opportunity with {{CampaignName}}',
      HtmlBody: '<p>Dear {{ContactName}},</p><p>Warm greetings from {{CampaignName}}.</p><p>We would like to invite {{CompanyName}} to explore a sponsorship opportunity with our event.</p><p>Please find our proposal attached for your consideration.</p><p>Thank you.</p><p>{{MemberSignature}}</p>',
      Active: true,
      UpdatedAt: now_(), Version: 1, Status: 'Published', UpdatedBy: 'System', CreatedAt: now_()
    },
    {
      TemplateId: uuid_('TPL'),
      Name: 'Follow-up',
      Type: 'Follow-up',
      Subject: 'Follow-up: Sponsorship Opportunity with {{CampaignName}}',
      HtmlBody: '<p>Dear {{ContactName}},</p><p>We are following up on our earlier sponsorship proposal to {{CompanyName}}.</p><p>We would be pleased to provide further information or discuss suitable collaboration arrangements.</p><p>Thank you.</p><p>{{MemberSignature}}</p>',
      Active: true,
      UpdatedAt: now_(), Version: 1, Status: 'Published', UpdatedBy: 'System', CreatedAt: now_()
    }
  ]);
}

function applyValidations_() {
  const ss = getDb_();
  setListValidation_(ss.getSheetByName(QB.SHEETS.MEMBERS), 'C2:C', QB.ROLES);
  setListValidation_(ss.getSheetByName(QB.SHEETS.APPROACHES), 'F2:F', QB.PIPELINE);
  setListValidation_(ss.getSheetByName(QB.SHEETS.APPROACHES), 'G2:G', QB.APPROVALS);
  setListValidation_(ss.getSheetByName(QB.SHEETS.COMPANIES), 'J2:J', ['Basic', 'Partial', 'Verified']);
  setListValidation_(ss.getSheetByName(QB.SHEETS.COMPANIES), 'K2:K', ['Active', 'Merged', 'Closed']);
  setListValidation_(ss.getSheetByName(QB.SHEETS.ASSETS), 'C2:C', ['Image', 'PDF']);
}

function setListValidation_(sheet, a1, values) {
  const rule = SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(false).build();
  sheet.getRange(a1).setDataValidation(rule);
}

function getSetting_(key) {
  const row = records_(QB.SHEETS.SETTINGS).find(function(item) { return item.Key === key; });
  return row ? row.Value : '';
}

function setSetting_(key, value, description) {
  const existing = recordById_(QB.SHEETS.SETTINGS, 'Key', key);
  if (existing) return updateById_(QB.SHEETS.SETTINGS, 'Key', key, { Value: value, Description: description || existing.Description });
  appendRows_(QB.SHEETS.SETTINGS, [{ Key: key, Value: value, Description: description || '' }]);
  return { Key: key, Value: value };
}

function settingsMap_() {
  return records_(QB.SHEETS.SETTINGS).reduce(function(map, row) {
    map[row.Key] = row.Value;
    return map;
  }, {});
}

function records_(sheetName) {
  const sheet = getDb_().getSheetByName(sheetName);
  if (!sheet) throw new Error('Missing sheet: ' + sheetName);
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];
  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = values.shift().map(String);
  return values.filter(function(row) {
    return row.some(function(value) { return value !== '' && value !== null; });
  }).map(function(row, index) {
    const obj = { _row: index + 2 };
    headers.forEach(function(header, col) { obj[header] = row[col]; });
    return obj;
  });
}

function appendRows_(sheetName, objects) {
  if (!objects || !objects.length) return [];
  const sheet = getDb_().getSheetByName(sheetName);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const rows = objects.map(function(obj) {
    return headers.map(function(header) { return obj[header] === undefined ? '' : obj[header]; });
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
  return objects;
}

function updateById_(sheetName, idHeader, id, patch) {
  const sheet = getDb_().getSheetByName(sheetName);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const idCol = headers.indexOf(idHeader) + 1;
  if (!idCol) throw new Error('Missing ID header: ' + idHeader);
  const finder = sheet.getRange(2, idCol, Math.max(1, sheet.getLastRow() - 1), 1)
    .createTextFinder(String(id)).matchEntireCell(true).findNext();
  if (!finder) throw new Error('Record not found: ' + id);
  Object.keys(patch).forEach(function(key) {
    const col = headers.indexOf(key) + 1;
    if (col) sheet.getRange(finder.getRow(), col).setValue(patch[key]);
  });
  return Object.assign({}, recordById_(sheetName, idHeader, id));
}

function recordById_(sheetName, idHeader, id) {
  return records_(sheetName).find(function(row) { return String(row[idHeader]) === String(id); }) || null;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(QB.LOCK_TIMEOUT_MS);
  try { return fn(); } finally { lock.releaseLock(); }
}

function serialize_(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serialize_);
  if (value && typeof value === 'object') {
    return Object.keys(value).reduce(function(out, key) {
      if (key !== '_row') out[key] = serialize_(value[key]);
      return out;
    }, {});
  }
  return value;
}
