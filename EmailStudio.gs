function getEmailStudioData(actorInput) {
  const actor = actorFrom_(actorInput);
  const canManageTemplates = ['Director', 'Admin'].indexOf(actor.role) >= 0;
  return serialize_({
    canManageTemplates: canManageTemplates,
    templates: canManageTemplates ? records_(QB.SHEETS.TEMPLATES).map(studioTemplate_) : [],
    assets: activeEmailAssets_()
  });
}

function studioTemplate_(row) {
  return {
    templateId: row.TemplateId,
    name: row.Name,
    type: row.Type,
    subject: row.Subject,
    htmlBody: storedHtmlBody_(row),
    active: row.Active !== false && String(row.Active).toLowerCase() !== 'false',
    version: Number(row.Version || 1),
    status: safeString_(row.Status) || 'Published',
    defaultAttachmentAssetIds: splitIds_(row.DefaultAttachmentAssetIds),
    updatedBy: safeString_(row.UpdatedBy),
    updatedAt: row.UpdatedAt
  };
}

function activeEmailAssets_() {
  const brandLogoAssetId = safeString_(getSetting_('BrandLogoAssetId'));
  return records_(QB.SHEETS.ASSETS).filter(function(row) {
    return row.Active !== false && String(row.Active).toLowerCase() !== 'false';
  }).map(function(row) {
    return {
      assetId: row.AssetId,
      name: row.Name,
      assetType: row.AssetType,
      mimeType: row.MimeType,
      fileName: row.FileName,
      altText: row.AltText,
      websiteUrl: row.WebsiteUrl,
      isBrandLogo: safeString_(row.AssetId) === brandLogoAssetId,
      uploadedBy: row.UploadedBy,
      createdAt: row.CreatedAt
    };
  });
}

function setBrandLogoAsset(assetId, actorInput) {
  const actor = actorFrom_(actorInput); requireRole_(actor, ['Director', 'Admin']);
  const asset = recordById_(QB.SHEETS.ASSETS, 'AssetId', safeString_(assetId));
  if (!asset || asset.AssetType !== 'Image') throw new Error('Select an uploaded image for the CRM logo.');
  const blob = DriveApp.getFileById(asset.DriveFileId).getBlob();
  if (blob.getBytes().length > 2 * 1024 * 1024) throw new Error('The CRM logo must be 2 MB or smaller. Compress the image and upload it again.');
  setSetting_('BrandLogoAssetId', asset.AssetId, 'Email Asset used as the CRM interface logo');
  logAudit_(actor, 'BRAND_LOGO_UPDATED', 'EmailAsset', asset.AssetId, { name: asset.Name });
  return { ok: true };
}

function getBrandLogoData() {
  const assetId = safeString_(getSetting_('BrandLogoAssetId'));
  if (!assetId) return null;
  const asset = recordById_(QB.SHEETS.ASSETS, 'AssetId', assetId);
  if (!asset || asset.AssetType !== 'Image') return null;
  try {
    const blob = DriveApp.getFileById(asset.DriveFileId).getBlob();
    const bytes = blob.getBytes();
    if (!bytes.length || bytes.length > 2 * 1024 * 1024) return null;
    return { dataUrl: 'data:' + (asset.MimeType || blob.getContentType()) + ';base64,' + Utilities.base64Encode(bytes), altText: safeString_(asset.AltText) || safeString_(asset.Name) || '全辩 logo' };
  } catch (ignore) { return null; }
}

function uploadEmailAsset(payload, actorInput) {
  const actor = actorFrom_(actorInput);
  payload = payload || {};
  const name = safeString_(payload.name) || safeString_(payload.fileName);
  const mimeType = safeString_(payload.mimeType).toLowerCase();
  const isImage = /^image\/(png|jpeg|gif|webp)$/.test(mimeType);
  const isPdf = mimeType === 'application/pdf' || /\.pdf$/i.test(safeString_(payload.fileName));
  if (!name) throw new Error('Give this asset a clear name.');
  if (!isImage && !isPdf) throw new Error('Upload a PNG, JPG, GIF, WebP or PDF file.');
  const bytes = Utilities.base64Decode(safeString_(payload.base64));
  const limit = isImage ? 5 * 1024 * 1024 : 20 * 1024 * 1024;
  if (!bytes.length || bytes.length > limit) throw new Error(isImage ? 'Images must be 5 MB or smaller.' : 'PDFs must be 20 MB or smaller.');
  if (payload.size && bytes.length !== Number(payload.size)) throw new Error('The upload was incomplete. Select the file again.');
  const createdAt = now_();
  const assetId = uuid_('AST');
  const fileName = safeString_(payload.fileName) || (isImage ? 'email-image' : 'attachment.pdf');
  const file = emailAssetFolder_().createFile(Utilities.newBlob(bytes, isPdf ? 'application/pdf' : mimeType, fileName));
  const row = {
    AssetId: assetId,
    Name: name,
    AssetType: isImage ? 'Image' : 'PDF',
    MimeType: isPdf ? 'application/pdf' : mimeType,
    DriveFileId: file.getId(),
    FileName: fileName,
    AltText: safeString_(payload.altText),
    WebsiteUrl: safeHttpUrl_(payload.websiteUrl),
    Active: true,
    UploadedBy: actor.memberName,
    CreatedAt: createdAt,
    UpdatedAt: createdAt
  };
  appendRows_(QB.SHEETS.ASSETS, [row]);
  logAudit_(actor, 'EMAIL_ASSET_UPLOADED', 'EmailAsset', assetId, { name: name, type: row.AssetType, bytes: bytes.length });
  return serialize_(activeEmailAssets_().find(function(item) { return item.assetId === assetId; }));
}

function getEmailAssetPreview(assetId, actorInput) {
  actorFrom_(actorInput);
  const asset = recordById_(QB.SHEETS.ASSETS, 'AssetId', safeString_(assetId));
  if (!asset || asset.AssetType !== 'Image') throw new Error('Image asset not found.');
  const blob = DriveApp.getFileById(asset.DriveFileId).getBlob();
  if (blob.getBytes().length > 5 * 1024 * 1024) throw new Error('This image is too large to preview.');
  return 'data:' + (asset.MimeType || blob.getContentType()) + ';base64,' + Utilities.base64Encode(blob.getBytes());
}

function saveEmailTemplate(payload, actorInput) {
  const actor = actorFrom_(actorInput); requireRole_(actor, ['Director', 'Admin']);
  payload = payload || {};
  const name = safeString_(payload.name);
  const emailType = normalizeEmailType_(payload.type);
  const subject = safeString_(payload.subject);
  const htmlBody = sanitizeEmailHtml_(canonicalizeAssetImageSources_(payload.htmlBody));
  if (!name) throw new Error('Template name is required.');
  if (!emailType) throw new Error('Email type is required. Enter an existing type or create a new one.');
  if (!subject) throw new Error('Email subject is required.');
  if (!htmlToText_(htmlBody)) throw new Error('Email body is required.');
  validateAssetReferences_(htmlBody);
  const defaultPdfIds = splitIds_(payload.defaultAttachmentAssetIds);
  validatePdfAssetIds_(defaultPdfIds);
  const templateId = safeString_(payload.templateId);
  const existing = templateId ? recordById_(QB.SHEETS.TEMPLATES, 'TemplateId', templateId) : null;
  const savedAt = now_();
  const status = safeString_(payload.status) === 'Draft' ? 'Draft' : 'Published';
  if (templateId && !existing) throw new Error('Template not found. Refresh the studio and try again.');
  const bodyFileId = saveEmailHtmlFile_(existing && existing.BodyDriveFileId, htmlBody, 'Template - ' + name + '.html');
  if (existing) {
    updateById_(QB.SHEETS.TEMPLATES, 'TemplateId', templateId, {
      Name: name, Type: emailType, Subject: subject,
      HtmlBody: '', BodyDriveFileId: bodyFileId, Active: payload.active !== false && String(payload.active).toLowerCase() !== 'false',
      Version: Number(existing.Version || 1) + 1, Status: status,
      DefaultAttachmentAssetIds: defaultPdfIds.join(','), UpdatedBy: actor.memberName, UpdatedAt: savedAt
    });
    logAudit_(actor, 'EMAIL_TEMPLATE_UPDATED', 'EmailTemplate', templateId, { name: name, version: Number(existing.Version || 1) + 1, status: status });
    return serialize_(studioTemplate_(recordById_(QB.SHEETS.TEMPLATES, 'TemplateId', templateId)));
  }
  const row = {
    TemplateId: uuid_('TPL'), Name: name, Type: emailType, Subject: subject,
    HtmlBody: '', BodyDriveFileId: bodyFileId, Active: true, UpdatedAt: savedAt,
    Version: 1, Status: status, DefaultAttachmentAssetIds: defaultPdfIds.join(','), UpdatedBy: actor.memberName, CreatedAt: savedAt
  };
  appendRows_(QB.SHEETS.TEMPLATES, [row]);
  logAudit_(actor, 'EMAIL_TEMPLATE_CREATED', 'EmailTemplate', row.TemplateId, { name: name, version: 1, status: status });
  return serialize_(studioTemplate_(row));
}

function normalizeEmailType_(value) {
  const type = safeString_(value).replace(/\s+/g, ' ');
  if (type.length > 60) throw new Error('Email type must be 60 characters or fewer.');
  return type;
}

function sendTemplateTest(payload, actorInput) {
  const actor = actorFrom_(actorInput); requireRole_(actor, ['Director', 'Admin']);
  const to = extractEmails_(payload.to);
  if (to.length !== 1) throw new Error('Enter one valid test email address.');
  const profile = memberEmailProfile_(actor.memberId);
  const html = sanitizeEmailHtml_(canonicalizeAssetImageSources_(payload.htmlBody));
  validateAssetReferences_(html);
  const values = {
    CompanyName: 'Sample Company', LegalName: 'Sample Company Sdn. Bhd.', ContactName: 'Marketing Team',
    CampaignName: settingsMap_().CampaignName, MemberName: actor.memberName, MemberTitle: profile.title,
    MemberPhone: profile.phone, MemberEmail: profile.email
  };
  values.MemberSignature = mergeHtmlTemplate_(profile.signatureHtml, values);
  let merged = mergeHtmlTemplate_(html, values);
  if (html.indexOf('{{MemberSignature}}') < 0 && values.MemberSignature) merged += '<br>' + values.MemberSignature;
  const assetIds = assetIdsFromHtml_(merged);
  const attachmentIds = splitIds_(payload.defaultAttachmentAssetIds);
  validatePdfAssetIds_(attachmentIds);
  const result = gmailApiSend_({
    to: to[0], subject: '[TEST] ' + mergeTemplate_(safeString_(payload.subject), values),
    htmlBody: merged, plainBody: htmlToText_(merged),
    attachments: assetFileBlobs_(attachmentIds), inlineImages: inlineAssetParts_(assetIds),
    senderName: settingsMap_().SenderName || '全辩 Marketing'
  });
  logAudit_(actor, 'EMAIL_TEMPLATE_TEST_SENT', 'EmailTemplate', safeString_(payload.templateId), { to: to[0], messageId: result.id });
  return { ok: true };
}

function sanitizeEmailHtml_(html) {
  let clean = String(html || '');
  clean = clean.replace(/<(script|style|iframe|object|embed|form|meta|link)[\s\S]*?<\/\1\s*>/gi, '');
  clean = clean.replace(/<(script|style|iframe|object|embed|form|meta|link)\b[^>]*\/?\s*>/gi, '');
  clean = clean.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  clean = clean.replace(/(href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi, '$1="#"');
  clean = clean.replace(/src\s*=\s*(["'])data:[\s\S]*?\1/gi, 'src="#"');
  return clean.trim();
}

function canonicalizeAssetImageSources_(html) {
  return String(html || '').replace(/<img\b[^>]*>/gi, function(tag) {
    const match = tag.match(/\bdata-cid=["'](AST-[A-Z0-9]+)["']/i) || tag.match(/\bdata-asset-id=["'](AST-[A-Z0-9]+)["']/i);
    if (!match) return tag;
    const source = 'src="cid:' + match[1].toUpperCase() + '"';
    return /\bsrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i.test(tag)
      ? tag.replace(/\bsrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, source)
      : tag.replace(/<img/i, '<img ' + source);
  });
}

function storedHtmlBody_(row) {
  const fileId = safeString_(row && (row.BodyDriveFileId || row.HtmlBodyFileId));
  if (!fileId) return safeString_(row && row.HtmlBody);
  try { return DriveApp.getFileById(fileId).getBlob().getDataAsString('UTF-8'); }
  catch (error) { throw new Error('The saved email body file is unavailable. Restore it from the CRM Drive folder or rebuild the template.'); }
}

function saveEmailHtmlFile_(existingFileId, html, fileName) {
  const content = String(html || '');
  const name = safeString_(fileName) || 'CRM Email Body.html';
  if (safeString_(existingFileId)) {
    try {
      const existing = DriveApp.getFileById(existingFileId);
      existing.setContent(content);
      existing.setName(name);
      return existing.getId();
    } catch (ignore) {}
  }
  return emailContentFolder_().createFile(Utilities.newBlob(content, 'text/html', name)).getId();
}

function emailContentFolder_() {
  const key = 'QB_EMAIL_CONTENT_FOLDER_ID';
  const properties = PropertiesService.getScriptProperties();
  const existing = properties.getProperty(key);
  if (existing) try { return DriveApp.getFolderById(existing); } catch (ignore) {}
  const folder = DriveApp.createFolder('全辩 CRM Email Content');
  properties.setProperty(key, folder.getId());
  return folder;
}

function safeHttpUrl_(value) {
  const url = safeString_(value);
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) throw new Error('Website links must begin with https:// or http://.');
  return url;
}

function splitIds_(value) {
  if (Array.isArray(value)) return value.map(safeString_).filter(Boolean);
  return safeString_(value).split(',').map(safeString_).filter(Boolean);
}

function assetIdsFromHtml_(html) {
  const ids = [];
  String(html || '').replace(/(?:cid:|data-cid=["'])(AST-[A-Z0-9]+)["']?/gi, function(match, id) {
    id = id.toUpperCase();
    if (ids.indexOf(id) < 0) ids.push(id);
    return match;
  });
  return ids;
}

function validateAssetReferences_(html) {
  String(html || '').replace(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi, function(match, source) {
    if (!/^cid:AST-[A-Z0-9]+$/i.test(source)) throw new Error('Insert pictures from the CRM Asset Library so they remain reliable in scheduled emails.');
    return match;
  });
  assetIdsFromHtml_(html).forEach(function(id) {
    const row = recordById_(QB.SHEETS.ASSETS, 'AssetId', id);
    if (!row || row.AssetType !== 'Image' || String(row.Active).toLowerCase() === 'false') throw new Error('An image in this design is no longer available: ' + id);
  });
}

function validatePdfAssetIds_(ids) {
  ids.forEach(function(id) {
    const row = recordById_(QB.SHEETS.ASSETS, 'AssetId', id);
    if (!row || row.AssetType !== 'PDF' || String(row.Active).toLowerCase() === 'false') throw new Error('A selected PDF is no longer available: ' + id);
  });
}

function inlineAssetParts_(ids) {
  return splitIds_(ids).map(function(id) {
    const row = recordById_(QB.SHEETS.ASSETS, 'AssetId', id);
    if (!row || row.AssetType !== 'Image') throw new Error('Inline image not found: ' + id);
    return { cid: id, blob: DriveApp.getFileById(row.DriveFileId).getBlob(), name: row.FileName, mimeType: row.MimeType };
  });
}

function assetFileBlobs_(ids) {
  return splitIds_(ids).map(function(id) {
    const row = recordById_(QB.SHEETS.ASSETS, 'AssetId', id);
    if (!row || row.AssetType !== 'PDF') throw new Error('PDF asset not found: ' + id);
    return DriveApp.getFileById(row.DriveFileId).getBlob().setName(row.FileName || row.Name || 'attachment.pdf');
  });
}

function emailAssetFolder_() {
  const key = 'QB_EMAIL_ASSET_FOLDER_ID';
  const properties = PropertiesService.getScriptProperties();
  const existing = properties.getProperty(key);
  if (existing) try { return DriveApp.getFolderById(existing); } catch (ignore) {}
  const folder = DriveApp.createFolder('全辩 CRM Email Studio Assets');
  properties.setProperty(key, folder.getId());
  return folder;
}

function mergeHtmlTemplate_(html, values) {
  return Object.keys(values).reduce(function(result, key) {
    const value = key === 'MemberSignature' ? safeString_(values[key]) : escapeHtmlServer_(values[key]);
    return result.replace(new RegExp('{{\\s*' + key + '\\s*}}', 'g'), value);
  }, safeString_(html));
}
