function getComposerData(approachId, actorInput) {
  const actor = actorFrom_(actorInput);
  const approach = ownedApproach_(approachId, actor);
  const company = recordById_(QB.SHEETS.COMPANIES, 'CompanyId', approach.CompanyId);
  const contacts = records_(QB.SHEETS.CONTACTS).filter(function(row) {
    return row.CompanyId === approach.CompanyId && row.ContactStatus !== 'Invalid';
  });
  return serialize_({ approach: approach, company: company, contacts: contacts, templates: activeTemplates_(), member: memberEmailProfile_(actor.memberId), quota: emailCapacity_() });
}

function queueApproachEmail(request, actorInput) {
  const actor = actorFrom_(actorInput);
  const row = buildQueueRow_(request, actor);
  appendRows_(QB.SHEETS.QUEUE, [row]);
  logAudit_(actor, 'EMAIL_QUEUED', 'Approach', row.ApproachId, { queueId: row.QueueId, scheduledAt: row.ScheduledAt });
  const result = row.ScheduledAt <= now_() ? processQueueIds_([row.QueueId]) : { sent: 0, failed: 0, queued: 1 };
  return serialize_(Object.assign(result, { queueId: row.QueueId, scheduledAt: row.ScheduledAt, capacity: emailCapacity_() }));
}

function queueBulkEmails(request, actorInput) {
  const actor = actorFrom_(actorInput);
  const approachIds = Array.isArray(request.approachIds) ? request.approachIds : [];
  if (!approachIds.length) throw new Error('Select at least one company.');
  if (approachIds.length > 100) throw new Error('A bulk batch can contain at most 100 companies.');
  const rows = approachIds.map(function(approachId) {
    return buildQueueRow_(Object.assign({}, request, { approachId: approachId, to: '', contactName: '' }), actor);
  });
  appendRows_(QB.SHEETS.QUEUE, rows);
  logAudit_(actor, 'BULK_EMAIL_QUEUED', 'EmailQueue', '', { count: rows.length, scheduledAt: rows[0].ScheduledAt });
  const batchSize = Number(getSetting_('QueueBatchSize') || 20);
  const result = rows[0].ScheduledAt <= now_() ? processQueueIds_(rows.slice(0, batchSize).map(function(row) { return row.QueueId; })) : { sent: 0, failed: 0, queued: rows.length };
  result.queued = rows.length - result.sent - result.failed;
  return serialize_(Object.assign(result, { total: rows.length, capacity: emailCapacity_() }));
}

function buildQueueRow_(request, actor) {
  const approach = ownedApproach_(request.approachId, actor);
  if (QB.CLOSED_STAGES.indexOf(approach.PipelineStage) >= 0) throw new Error('This approach is already closed.');
  const company = recordById_(QB.SHEETS.COMPANIES, 'CompanyId', approach.CompanyId);
  const contacts = records_(QB.SHEETS.CONTACTS).filter(function(row) { return row.CompanyId === approach.CompanyId && row.ContactStatus !== 'Invalid'; });
  const recipients = extractEmails_(request.to || contacts.map(function(row) { return row.Email; }).filter(Boolean)[0]);
  if (!recipients.length) throw new Error(company.DisplayName + ' has no valid recipient email.');
  const template = recordById_(QB.SHEETS.TEMPLATES, 'TemplateId', request.templateId);
  if (!template) throw new Error('Email template not found.');
  const settings = settingsMap_();
  const profile = memberEmailProfile_(actor.memberId);
  const contactName = safeString_(request.contactName) || contacts.map(function(row) { return row.ContactName; }).filter(Boolean)[0] || 'Sir / Madam';
  const values = {
    CompanyName: company.DisplayName, LegalName: company.LegalName || company.DisplayName,
    ContactName: contactName, CampaignName: settings.CampaignName, MemberName: actor.memberName,
    MemberTitle: profile.title, MemberPhone: profile.phone, MemberEmail: profile.email
  };
  values.MemberSignature = mergeHtmlTemplate_(profile.signatureHtml, values);
  const sourceBody = sanitizeEmailHtml_(canonicalizeAssetImageSources_(request.htmlBody || templateBody_(template)));
  validateAssetReferences_(sourceBody);
  let htmlBody = mergeHtmlTemplate_(sourceBody, values);
  if (sourceBody.indexOf('{{MemberSignature}}') < 0 && values.MemberSignature) htmlBody += '<br>' + values.MemberSignature;
  const inlineAssetIds = assetIdsFromHtml_(htmlBody);
  const defaultAttachmentFileIds = splitIds_(template.DefaultAttachmentAssetIds).map(function(assetId) {
    const asset = recordById_(QB.SHEETS.ASSETS, 'AssetId', assetId);
    if (!asset || asset.AssetType !== 'PDF') throw new Error('A default template PDF is missing: ' + assetId);
    return asset.DriveFileId;
  });
  const uploadedAttachmentFileIds = Array.isArray(request.attachmentFileIds) ? request.attachmentFileIds.map(safeString_).filter(Boolean) : [];
  const scheduledAt = request.scheduledAtIso ? new Date(request.scheduledAtIso) : now_();
  if (isNaN(scheduledAt.getTime())) throw new Error('The scheduled date and time is invalid.');
  const queueId = uuid_('QUE');
  const htmlBodyFileId = saveEmailHtmlFile_('', htmlBody, 'Queued Email - ' + queueId + '.html');
  return {
    QueueId: queueId, ApproachId: approach.ApproachId, CompanyId: approach.CompanyId,
    MemberId: actor.memberId, MemberName: actor.memberName,
    Mode: request.mode || (approach.GmailThreadId ? 'Follow-up' : 'First Approach'), TemplateId: template.TemplateId,
    To: recipients.join(','), Cc: extractEmails_(request.cc).join(','), Bcc: extractEmails_(request.bcc).join(','), ContactName: contactName,
    Subject: mergeTemplate_(safeString_(request.subject) || template.Subject, values), HtmlBody: '', HtmlBodyFileId: htmlBodyFileId,
    AttachmentLinks: safeString_(request.attachmentLinks), AttachmentFileIds: defaultAttachmentFileIds.concat(uploadedAttachmentFileIds).join(','),
    InlineAssetIds: inlineAssetIds.join(','), TemplateVersion: Number(template.Version || 1),
    ScheduledAt: scheduledAt,
    Status: 'Scheduled', Attempts: 0, LastError: '', CreatedAt: now_(), UpdatedAt: now_()
  };
}

function processScheduledEmails() {
  setSetting_('LastQueueRunAt', now_(), 'Updated automatically by the scheduler');
  const batchSize = Number(getSetting_('QueueBatchSize') || 20);
  const due = records_(QB.SHEETS.QUEUE).filter(function(row) {
    return ['Scheduled', 'Retry'].indexOf(row.Status) >= 0 && row.ScheduledAt instanceof Date && row.ScheduledAt <= now_();
  }).sort(function(a, b) { return dateValue_(a.ScheduledAt) - dateValue_(b.ScheduledAt); }).slice(0, batchSize);
  return processQueueIds_(due.map(function(row) { return row.QueueId; }));
}

function processQueueIds_(queueIds) {
  if (!queueIds.length) return { sent: 0, failed: 0, queued: 0 };
  let sent = 0;
  let failed = 0;
  queueIds.forEach(function(queueId) {
    let row;
    try {
      row = withLock_(function() {
        const current = recordById_(QB.SHEETS.QUEUE, 'QueueId', queueId);
        if (!current || ['Sent', 'Cancelled', 'Processing'].indexOf(current.Status) >= 0) return null;
        enforceSendCapacity_(extractEmails_(current.To).length + extractEmails_(current.Cc).length + extractEmails_(current.Bcc).length);
        updateById_(QB.SHEETS.QUEUE, 'QueueId', queueId, { Status: 'Processing', Attempts: Number(current.Attempts || 0) + 1, UpdatedAt: now_() });
        return current;
      });
    } catch (claimError) {
      updateById_(QB.SHEETS.QUEUE, 'QueueId', queueId, { Status: 'Retry', LastError: claimError.message, UpdatedAt: now_() });
      failed++;
      return;
    }
    if (!row) return;
    try {
      sendQueueRow_(row);
      sent++;
    } catch (error) {
      const current = recordById_(QB.SHEETS.QUEUE, 'QueueId', queueId);
      if (current && current.Status === 'Sent') {
        logAudit_(null, 'EMAIL_POST_SEND_SYNC_ERROR', 'EmailQueue', queueId, { error: error.message });
        sent++;
        return;
      }
      const attempts = Number(row.Attempts || 0) + 1;
      updateById_(QB.SHEETS.QUEUE, 'QueueId', queueId, { Status: attempts < 3 ? 'Retry' : 'Failed', Attempts: attempts, LastError: error.message, UpdatedAt: now_() });
      logAudit_(null, 'EMAIL_QUEUE_ERROR', 'EmailQueue', queueId, { error: error.message, attempts: attempts });
      failed++;
    }
  });
  return { sent: sent, failed: failed, queued: queueIds.length - sent - failed };
}

function sendQueueRow_(row) {
  const approach = recordById_(QB.SHEETS.APPROACHES, 'ApproachId', row.ApproachId);
  if (!approach) throw new Error('Approach no longer exists.');
  const settings = settingsMap_();
  const isFollowUp = row.Mode === 'Follow-up' && approach.GmailThreadId;
  let replyHeaders = {};
  if (isFollowUp) {
    const originalThread = GmailApp.getThreadById(approach.GmailThreadId);
    if (!originalThread) throw new Error('The original Gmail thread could not be found.');
    const messages = originalThread.getMessages();
    const last = messages[messages.length - 1];
    replyHeaders = { threadId: approach.GmailThreadId, inReplyTo: last.getHeader('Message-ID'), references: last.getHeader('References') || last.getHeader('Message-ID') };
  }
  const queuedHtmlBody = storedHtmlBody_(row);
  const result = gmailApiSend_({
    to: row.To, cc: row.Cc, bcc: row.Bcc, subject: row.Subject,
    htmlBody: queuedHtmlBody, plainBody: htmlToText_(queuedHtmlBody),
    attachments: driveAttachments_(row.AttachmentLinks || '').concat(driveFileAttachments_(row.AttachmentFileIds || '')),
    inlineImages: inlineAssetParts_(row.InlineAssetIds || assetIdsFromHtml_(queuedHtmlBody)),
    senderName: settings.SenderName || '全辩 Marketing', threadId: replyHeaders.threadId,
    inReplyTo: replyHeaders.inReplyTo, references: replyHeaders.references
  });
  const sentAt = now_();
  updateById_(QB.SHEETS.QUEUE, 'QueueId', row.QueueId, { Status: 'Sent', GmailThreadId: result.threadId, GmailMessageId: result.id, SentAt: sentAt, LastError: '', UpdatedAt: sentAt });
  const followUpCount = Number(approach.FollowUpCount || 0) + (isFollowUp ? 1 : 0);
  const businessDays = Number(isFollowUp ? settings.LaterFollowUpBusinessDays || 7 : settings.FirstFollowUpBusinessDays || 5);
  const nextFollowUp = addBusinessDays_(sentAt, businessDays);
  updateById_(QB.SHEETS.APPROACHES, 'ApproachId', approach.ApproachId, {
    PipelineStage: 'Contacted', ApprovalStatus: 'Approved', LastContactAt: sentAt, NextFollowUpAt: nextFollowUp,
    FollowUpCount: followUpCount, GmailThreadId: result.threadId, GmailMessageId: result.id, ReplyActionStatus: '', UpdatedAt: sentAt
  });
  const actor = { memberId: row.MemberId, memberName: row.MemberName, sessionId: 'EMAIL-QUEUE', deviceSummary: 'Scheduled email processor' };
  addInteraction_(approach.ApproachId, approach.CompanyId, actor, 'Email', 'Outgoing', isFollowUp ? 'Follow-up sent' : 'First approach sent', row.Subject, 'Sent to ' + row.To, sentAt, { threadId: result.threadId, messageId: result.id });
  labelThreadById_(result.threadId, approach);
  logAudit_(actor, 'EMAIL_SENT', 'Approach', approach.ApproachId, { to: row.To, mode: row.Mode, queueId: row.QueueId, threadId: result.threadId });
}

function gmailApiSend_(message) {
  const boundaryMixed = 'qb_mixed_' + Utilities.getUuid().replace(/-/g, '');
  const boundaryRelated = 'qb_related_' + Utilities.getUuid().replace(/-/g, '');
  const boundaryAlt = 'qb_alt_' + Utilities.getUuid().replace(/-/g, '');
  const headers = [
    'MIME-Version: 1.0', 'To: ' + cleanHeader_(message.to),
    message.cc ? 'Cc: ' + cleanHeader_(message.cc) : '', message.bcc ? 'Bcc: ' + cleanHeader_(message.bcc) : '',
    'Subject: =?UTF-8?B?' + Utilities.base64Encode(message.subject, Utilities.Charset.UTF_8) + '?=',
    'From: =?UTF-8?B?' + Utilities.base64Encode(message.senderName, Utilities.Charset.UTF_8) + '?= <' + Session.getEffectiveUser().getEmail() + '>',
    message.inReplyTo ? 'In-Reply-To: ' + cleanHeader_(message.inReplyTo) : '',
    message.references ? 'References: ' + cleanHeader_(message.references) : '',
    'Content-Type: multipart/mixed; boundary="' + boundaryMixed + '"'
  ].filter(Boolean);
  const parts = [headers.join('\r\n'), '', '--' + boundaryMixed,
    'Content-Type: multipart/related; boundary="' + boundaryRelated + '"', '', '--' + boundaryRelated,
    'Content-Type: multipart/alternative; boundary="' + boundaryAlt + '"', '',
    '--' + boundaryAlt, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', Utilities.base64Encode(message.plainBody, Utilities.Charset.UTF_8),
    '--' + boundaryAlt, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', Utilities.base64Encode(message.htmlBody, Utilities.Charset.UTF_8), '--' + boundaryAlt + '--'
  ];
  (message.inlineImages || []).forEach(function(item) {
    const mimeType = item.mimeType || item.blob && item.blob.getContentType() || 'image/png';
    const name = item.name || item.blob && item.blob.getName() || 'embedded-image';
    const encoded = item.base64 || Utilities.base64Encode(item.blob.getBytes());
    parts.push('--' + boundaryRelated, 'Content-Type: ' + mimeType + '; name="' + cleanHeader_(name) + '"',
      'Content-Disposition: inline; filename="' + cleanHeader_(name) + '"', 'Content-ID: <' + cleanHeader_(item.cid) + '>',
      'Content-Transfer-Encoding: base64', '', encoded);
  });
  parts.push('--' + boundaryRelated + '--');
  (message.attachments || []).forEach(function(item) {
    const isEncodedPart = item && item.base64;
    const mimeType = isEncodedPart ? item.mimeType : item.getContentType() || 'application/octet-stream';
    const name = isEncodedPart ? item.name : item.getName();
    const encoded = isEncodedPart ? item.base64 : Utilities.base64Encode(item.getBytes());
    parts.push('--' + boundaryMixed, 'Content-Type: ' + mimeType + '; name="' + cleanHeader_(name) + '"',
      'Content-Disposition: attachment; filename="' + cleanHeader_(name) + '"', 'Content-Transfer-Encoding: base64', '', encoded);
  });
  parts.push('--' + boundaryMixed + '--');
  const resource = { raw: Utilities.base64EncodeWebSafe(parts.join('\r\n'), Utilities.Charset.UTF_8) };
  if (message.threadId) resource.threadId = message.threadId;
  return Gmail.Users.Messages.send(resource, 'me');
}

function syncGmailReplies(actorInput) {
  const startedAt = now_();
  let actor = null;
  if (actorInput && actorInput.memberId) try { actor = actorFrom_(actorInput); } catch (ignore) {}
  const tracked = records_(QB.SHEETS.APPROACHES).filter(function(row) { return row.GmailThreadId && QB.CLOSED_STAGES.indexOf(row.PipelineStage) < 0; });
  let recentCandidateIds = new Set();
  let discoveryError = '';
  try { recentCandidateIds = recentGmailThreadIds_(); }
  catch (error) { discoveryError = error.message; }
  const newestTracked = tracked.slice().sort(function(a, b) { return dateValue_(b.LastContactAt) - dateValue_(a.LastContactAt); }).slice(0, 20);
  const selectedIds = new Set(newestTracked.map(function(row) { return String(row.GmailThreadId); }));
  tracked.forEach(function(row) { if (recentCandidateIds.has(String(row.GmailThreadId))) selectedIds.add(String(row.GmailThreadId)); });
  const approaches = tracked.filter(function(row) { return selectedIds.has(String(row.GmailThreadId)); });
  const knownMessageIds = new Set(records_(QB.SHEETS.INTERACTIONS).map(function(row) { return String(row.GmailMessageId || ''); }).filter(Boolean));
  const sender = safeString_(Session.getEffectiveUser().getEmail()).toLowerCase();
  let replyCount = 0;
  let automatedCount = 0;
  let deliveryIssueCount = 0;
  let errorCount = discoveryError ? 1 : 0;
  approaches.forEach(function(approach) {
    try {
      const thread = GmailApp.getThreadById(approach.GmailThreadId);
      if (!thread) return;
      thread.getMessages().forEach(function(message) {
        if (knownMessageIds.has(message.getId())) return;
        const from = extractAddress_(message.getFrom());
        if (!from || from === sender) return;
        const receivedAt = message.getDate();
        if (dateValue_(receivedAt) <= dateValue_(approach.LastContactAt)) return;
        const plainBody = message.getPlainBody();
        const snippet = truncate_(plainBody, 500);
        const classification = classifyInboundEmail_(from, message.getSubject(), plainBody, {
          autoSubmitted: messageHeader_(message, 'Auto-Submitted'),
          autoReply: messageHeader_(message, 'X-Autoreply'),
          autoRespond: messageHeader_(message, 'X-Autorespond'),
          precedence: messageHeader_(message, 'Precedence')
        });
        addInteraction_(approach.ApproachId, approach.CompanyId, null, 'Email', 'Incoming', classification.type === 'Human reply' ? 'Reply received' : 'System response: ' + classification.type, message.getSubject(), snippet, receivedAt, { threadId: thread.getId(), messageId: message.getId() });
        knownMessageIds.add(message.getId());
        const inboundPatch = {
          LastInboundType: classification.type, LastInboundAt: receivedAt, LastInboundFrom: from,
          LastInboundSnippet: snippet, UpdatedAt: now_()
        };
        if (classification.type === 'Human reply') {
          Object.assign(inboundPatch, {
            PipelineStage: 'Replied', LastReplyAt: receivedAt, NextFollowUpAt: '', LastReplyFrom: from,
            ReplySnippet: snippet, ReplyActionStatus: 'Awaiting action'
          });
          labelReplyThread_(thread);
          try { notifyReplyRecipients_(approach, from, snippet, receivedAt, classification); }
          catch (notificationError) { logAudit_(null, 'REPLY_NOTIFICATION_ERROR', 'Approach', approach.ApproachId, { error: notificationError.message }); }
          replyCount++;
        } else {
          inboundPatch.SystemActionStatus = 'Needs review';
          labelAutomatedThread_(thread, classification.type);
          automatedCount++;
          if (classification.actionable) {
            deliveryIssueCount++;
            try { notifyReplyRecipients_(approach, from, snippet, receivedAt, classification); }
            catch (notificationError) { logAudit_(null, 'REPLY_NOTIFICATION_ERROR', 'Approach', approach.ApproachId, { error: notificationError.message }); }
          }
        }
        updateById_(QB.SHEETS.APPROACHES, 'ApproachId', approach.ApproachId, inboundPatch);
        logAudit_(null, classification.type === 'Human reply' ? 'REPLY_DETECTED' : 'AUTOMATED_RESPONSE_DETECTED', 'Approach', approach.ApproachId, { from: from, messageId: message.getId(), classification: classification.type, reason: classification.reason });
      });
    } catch (error) {
      errorCount++;
      logAudit_(actor, 'REPLY_SYNC_ERROR', 'Approach', approach.ApproachId, { error: error.message });
    }
  });
  const completedAt = now_();
  setSetting_('LastReplySyncAt', completedAt, 'Updated after every completed Gmail reply scan');
  const result = { tracked: tracked.length, checked: approaches.length, recentCandidates: recentCandidateIds.size, replies: replyCount, automated: automatedCount, deliveryIssues: deliveryIssueCount, errors: errorCount, discoveryError: discoveryError, durationSeconds: Math.max(0, Math.round((completedAt.getTime() - startedAt.getTime()) / 100) / 10), completedAt: completedAt };
  logAudit_(actor, 'REPLY_SYNC_COMPLETED', 'Gmail', '', result);
  return serialize_(result);
}

function messageHeader_(message, name) {
  try { return safeString_(message.getHeader(name)); }
  catch (ignore) { return ''; }
}

function classifyInboundEmail_(from, subject, body, headers) {
  const source = [from, subject, safeString_(body).slice(0, 4000)].map(function(value) { return safeString_(value).toLowerCase(); }).join('\n');
  headers = headers || {};
  const automationHeaders = [headers.autoSubmitted, headers.autoReply, headers.autoRespond, headers.precedence]
    .map(function(value) { return safeString_(value).toLowerCase(); }).join(' ');

  const mailboxFull = /mailbox (?:is )?full|mailbox has exceeded|mailbox quota|quota exceeded|over quota|recipient(?:'s)? inbox is full|storage limit|insufficient system storage|mailbox unavailable.*full|552[ -].*(?:quota|mailbox)|邮箱已满|信箱已满|超过.{0,8}(?:容量|配额)/i.test(source);
  if (mailboxFull) return { type: 'Mailbox full', actionable: true, reason: 'The recipient mailbox cannot currently accept new mail.' };

  const failedSender = /mailer-daemon|postmaster|mail delivery subsystem|mail delivery system/i.test(from);
  const deliveryFailed = failedSender || /delivery status notification \(failure\)|delivery has failed|delivery failure|delivery incomplete|undeliverable|undelivered mail|returned mail|failure notice|address not found|recipient address rejected|user unknown|no such user|does not exist|couldn't be delivered|could not be delivered|550[ -].*(?:unknown|rejected|not found|does not exist)|无法送达|投递失败|收件人.{0,8}不存在|地址不存在|退信/i.test(source);
  if (deliveryFailed) return { type: 'Delivery failed', actionable: true, reason: 'Gmail reported that the message could not be delivered.' };

  const outOfOffice = /out of office|automatic reply:|auto-reply:|vacation responder|away from (?:the )?office|currently away|on (?:annual )?leave|maternity leave|returning on|limited access to (?:my )?email|不在办公室|外出办公|正在休假|自动回复.{0,12}休假/i.test(source);
  if (outOfOffice) return { type: 'Out of office', actionable: false, reason: 'The recipient sent an absence notice.' };

  const automatedHeader = /auto-replied|auto-generated|bulk|list|junk/.test(automationHeaders) && !/\bno\b/.test(automationHeaders);
  const acknowledgement = automatedHeader || /automated (?:reply|response|message)|auto response|thank you for (?:contacting|your email|reaching out)|we (?:have )?received your (?:email|message|enquiry|inquiry)|your (?:email|message|request) has been received|do not reply to this (?:email|message)|this is an automatically generated|系统自动|已收到您的邮件|已收到来信|自动回复/i.test(source);
  if (acknowledgement) return { type: 'Auto acknowledgement', actionable: false, reason: 'The sender confirmed receipt automatically.' };

  return { type: 'Human reply', actionable: true, reason: 'No automated-response indicators were detected.' };
}

function recentGmailThreadIds_() {
  const now = now_();
  const previous = getSetting_('LastReplySyncAt');
  const previousDate = previous instanceof Date ? previous : previous ? new Date(previous) : null;
  const since = previousDate && !isNaN(previousDate.getTime()) ? new Date(previousDate.getTime() - 2 * 24 * 60 * 60 * 1000) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const query = 'in:anywhere after:' + Utilities.formatDate(since, 'GMT', 'yyyy/MM/dd');
  const ids = new Set();
  let pageToken = '';
  let pages = 0;
  do {
    const options = { q: query, maxResults: 500 };
    if (pageToken) options.pageToken = pageToken;
    const response = Gmail.Users.Threads.list('me', options) || {};
    (response.threads || []).forEach(function(thread) { if (thread.id) ids.add(String(thread.id)); });
    pageToken = response.nextPageToken || '';
    pages++;
  } while (pageToken && pages < 4);
  return ids;
}

function createAutomationTriggers() {
  const handlerNames = ['syncGmailReplies', 'processScheduledEmails', 'expireUnusedReservations'];
  ScriptApp.getProjectTriggers().forEach(function(trigger) { if (handlerNames.indexOf(trigger.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(trigger); });
  ScriptApp.newTrigger('syncGmailReplies').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('processScheduledEmails').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('expireUnusedReservations').timeBased().everyDays(1).atHour(6).create();
  return { ok: true };
}

function expireUnusedReservations() {
  const current = now_();
  const approaches = records_(QB.SHEETS.APPROACHES).filter(function(row) { return row.PipelineStage === 'Researching' && !row.LastContactAt && row.ReservationExpiresAt instanceof Date && row.ReservationExpiresAt < current; });
  approaches.forEach(function(row) {
    updateById_(QB.SHEETS.APPROACHES, 'ApproachId', row.ApproachId, { PipelineStage: 'Closed', Outcome: 'Reservation expired', UpdatedAt: current });
    logAudit_(null, 'RESERVATION_EXPIRED', 'Approach', row.ApproachId, { owner: row.OwnerName });
  });
  return { expired: approaches.length };
}

function emailCapacity_() {
  const settings = settingsMap_();
  const limit = Number(settings.DailySendSafetyLimit || 450);
  const timezone = settings.Timezone || 'Asia/Kuala_Lumpur';
  const today = Utilities.formatDate(now_(), timezone, 'yyyy-MM-dd');
  const sent = records_(QB.SHEETS.QUEUE).filter(function(row) { return row.Status === 'Sent' && row.SentAt instanceof Date && Utilities.formatDate(row.SentAt, timezone, 'yyyy-MM-dd') === today; })
    .reduce(function(total, row) { return total + extractEmails_(row.To).length + extractEmails_(row.Cc).length + extractEmails_(row.Bcc).length; }, 0);
  return { limit: limit, sent: sent, remaining: Math.max(0, limit - sent), provider: 'Gmail API' };
}

function enforceSendCapacity_(recipientCount) {
  const capacity = emailCapacity_();
  if (capacity.remaining < recipientCount) throw new Error('The CRM daily safety limit of ' + capacity.limit + ' recipients has been reached. Remaining messages stay queued.');
}

function templateBody_(template) {
  return storedHtmlBody_(template);
}

function memberEmailProfile_(memberId) {
  const row = recordById_(QB.SHEETS.MEMBERS, 'MemberId', memberId) || {};
  const signature = safeString_(row.SignatureHtml) || ['<strong>' + escapeHtmlServer_(row.MemberName || '') + '</strong>', escapeHtmlServer_(row.Title || ''), escapeHtmlServer_(row.Phone || ''), escapeHtmlServer_(row.Email || '')].filter(Boolean).join('<br>');
  return { email: safeString_(row.Email), title: safeString_(row.Title), phone: safeString_(row.Phone), signatureHtml: signature, notificationEmail: safeString_(row.NotificationEmail), notifyOnReplies: row.NotifyOnReplies === true || String(row.NotifyOnReplies).toLowerCase() === 'true' };
}

function notifyReplyRecipients_(approach, from, snippet, receivedAt, classification) {
  const members = records_(QB.SHEETS.MEMBERS).filter(function(member) {
    const active = member.Active !== false && String(member.Active).toLowerCase() !== 'false';
    const enabled = member.NotifyOnReplies === true || String(member.NotifyOnReplies).toLowerCase() === 'true';
    return active && enabled && (member.MemberId === approach.OwnerMemberId || ['Director', 'Admin'].indexOf(member.Role) >= 0);
  });
  const recipients = [];
  members.forEach(function(member) {
    extractEmails_(member.NotificationEmail).forEach(function(email) { if (recipients.indexOf(email) < 0) recipients.push(email); });
  });
  if (!recipients.length) return { sent: 0 };
  const company = recordById_(QB.SHEETS.COMPANIES, 'CompanyId', approach.CompanyId) || {};
  const companyName = company.DisplayName || 'Company';
  const settings = settingsMap_();
  classification = classification || { type: 'Human reply' };
  const isHuman = classification.type === 'Human reply';
  const notificationTitle = isHuman ? 'New company reply detected' : 'Company email needs attention: ' + classification.type;
  const html = '<p><strong>' + escapeHtmlServer_(notificationTitle) + '</strong></p>' +
    '<p><strong>Company:</strong> ' + escapeHtmlServer_(companyName) + '<br>' +
    '<strong>Assigned member:</strong> ' + escapeHtmlServer_(approach.OwnerName) + '<br>' +
    '<strong>Message type:</strong> ' + escapeHtmlServer_(classification.type) + '<br>' +
    '<strong>From:</strong> ' + escapeHtmlServer_(from) + '<br>' +
    '<strong>Received:</strong> ' + escapeHtmlServer_(Utilities.formatDate(receivedAt, settings.Timezone || 'Asia/Kuala_Lumpur', 'yyyy-MM-dd HH:mm')) + '</p>' +
    '<p>' + escapeHtmlServer_(truncate_(snippet, 500)).replace(/\n/g, '<br>') + '</p>' +
    '<p>Open <strong>Inbox review</strong> in the CRM to check the message and record the next action.</p>';
  gmailApiSend_({
    to: recipients[0], bcc: recipients.slice(1).join(','),
    subject: (isHuman ? 'CRM reply: ' : 'CRM delivery issue: ') + companyName,
    htmlBody: html, plainBody: htmlToText_(html), attachments: [], inlineImages: [],
    senderName: settings.SenderName || '全辩 Marketing'
  });
  logAudit_(null, 'REPLY_NOTIFICATION_SENT', 'Approach', approach.ApproachId, { recipientCount: recipients.length, company: companyName });
  return { sent: recipients.length };
}

function labelReplyThread_(thread) {
  const name = 'CRM/Reply Awaiting Action';
  let label = GmailApp.getUserLabelByName(name);
  if (!label) label = GmailApp.createLabel(name);
  thread.addLabel(label);
}

function labelAutomatedThread_(thread, type) {
  const name = ['Delivery failed', 'Mailbox full'].indexOf(type) >= 0 ? 'CRM/Delivery Issues' : 'CRM/Automated Responses';
  let label = GmailApp.getUserLabelByName(name);
  if (!label) label = GmailApp.createLabel(name);
  thread.addLabel(label);
}

function mergeTemplate_(text, values) {
  return Object.keys(values).reduce(function(result, key) { return result.replace(new RegExp('{{\\s*' + key + '\\s*}}', 'g'), safeString_(values[key])); }, safeString_(text));
}
function driveAttachments_(links) {
  return safeString_(links).split(/[\n,]+/).map(function(link) { const match = link.match(/[-\w]{25,}/); if (!match) return null; try { return DriveApp.getFileById(match[0]).getBlob(); } catch (ignore) { return null; } }).filter(Boolean);
}
function driveFileAttachments_(ids) {
  return safeString_(ids).split(',').map(function(id) {
    id = safeString_(id);
    if (!id) return null;
    try { return DriveApp.getFileById(id).getBlob(); } catch (ignore) { return null; }
  }).filter(Boolean);
}

function uploadEmailAttachments(files, actorInput) {
  const actor = actorFrom_(actorInput);
  files = Array.isArray(files) ? files : [];
  if (!files.length) return [];
  const total = files.reduce(function(sum, file) { return sum + Number(file.size || 0); }, 0);
  if (total > 20 * 1024 * 1024) throw new Error('PDF attachments exceed the 20 MB CRM limit.');
  const folder = emailAttachmentFolder_();
  const ids = files.map(function(file) {
    if (safeString_(file.mimeType) !== 'application/pdf' && !/\.pdf$/i.test(safeString_(file.name))) throw new Error('Only PDF attachments are accepted.');
    const bytes = Utilities.base64Decode(safeString_(file.base64));
    if (bytes.length !== Number(file.size || bytes.length)) throw new Error('The PDF upload was incomplete: ' + file.name);
    return folder.createFile(Utilities.newBlob(bytes, 'application/pdf', safeString_(file.name) || 'attachment.pdf')).getId();
  });
  logAudit_(actor, 'EMAIL_ATTACHMENTS_UPLOADED', 'DriveFile', '', { count: ids.length, totalBytes: total });
  return ids;
}

function emailAttachmentFolder_() {
  const key = 'QB_EMAIL_ATTACHMENT_FOLDER_ID';
  const properties = PropertiesService.getScriptProperties();
  const existing = properties.getProperty(key);
  if (existing) try { return DriveApp.getFolderById(existing); } catch (ignore) {}
  const folder = DriveApp.createFolder('全辩 CRM Email Attachments');
  properties.setProperty(key, folder.getId());
  return folder;
}
function addBusinessDays_(date, days) {
  const result = new Date(date.getTime()); let added = 0;
  while (added < days) { result.setDate(result.getDate() + 1); if (result.getDay() !== 0 && result.getDay() !== 6) added++; }
  result.setHours(9, 0, 0, 0); return result;
}
function labelThreadById_(threadId, approach) {
  const thread = GmailApp.getThreadById(threadId); if (!thread) return;
  ['全辩 Marketing', 'Campaign/' + activeCampaignId_(), 'Owner/' + approach.OwnerName, 'CRM/Tracked'].forEach(function(name) {
    const clean = name.replace(/[~!@#$%^&*(){}\[\]]/g, '').slice(0, 200); let label = GmailApp.getUserLabelByName(clean); if (!label) label = GmailApp.createLabel(clean); thread.addLabel(label);
  });
}
function htmlToText_(html) { return safeString_(html).replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim(); }
function plainTextToHtml_(text) { return safeString_(text).split(/\n{2,}/).map(function(block) { return '<p>' + escapeHtmlServer_(block).replace(/\n/g, '<br>') + '</p>'; }).join(''); }
function escapeHtmlServer_(value) { return safeString_(value).replace(/[&<>"']/g, function(c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
function cleanHeader_(value) { return safeString_(value).replace(/[\r\n]+/g, ' '); }
function extractAddress_(from) { const match = safeString_(from).toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/); return match ? match[0] : ''; }
function truncate_(text, length) { text = safeString_(text); return text.length > length ? text.slice(0, length - 3) + '...' : text; }
