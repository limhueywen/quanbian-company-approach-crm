function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('全辩 Company Approach CRM')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(filename) {
  // Read partials without asking HtmlService to validate them as standalone
  // HTML documents. App.html intentionally contains JavaScript source only and
  // Index.html owns the single <script> wrapper around it.
  return HtmlService.createTemplateFromFile(filename).getRawContent();
}

function includeBase64(filename) {
  // Apps Script renders force-printed template values through document.write().
  // Transporting JavaScript as Base64 prevents quotes, line separators and
  // rich-template content from breaking Google's generated writer.
  return Utilities.base64Encode(
    HtmlService.createTemplateFromFile(filename).getRawContent(),
    Utilities.Charset.UTF_8
  );
}

function getBootstrapData() {
  const settings = settingsMap_();
  const members = records_(QB.SHEETS.MEMBERS)
    .filter(function(member) { return member.Active !== false && String(member.Active).toLowerCase() !== 'false'; })
    .map(function(member) { return { memberId: member.MemberId, memberName: member.MemberName, role: member.Role }; });
  return serialize_({
    campaign: { id: settings.CampaignId, name: settings.CampaignName },
    members: members,
    templates: [],
    quota: emailCapacity_()
  });
}

function getActiveTemplates(actorInput) {
  actorFrom_(actorInput);
  return serialize_(activeTemplates_());
}

function getDashboard(actorInput) {
  const actor = actorFrom_(actorInput); touchSession_(actor);
  const campaignId = activeCampaignId_();
  const all = records_(QB.SHEETS.APPROACHES).filter(function(row) { return row.CampaignId === campaignId; });
  const mine = actor.role === 'Admin' ? all : all.filter(function(row) { return row.OwnerMemberId === actor.memberId; });
  const now = now_();
  const due = mine.filter(function(row) {
    return row.NextFollowUpAt instanceof Date && row.NextFollowUpAt <= now && QB.CLOSED_STAGES.indexOf(row.PipelineStage) < 0;
  });
  const replies = mine.filter(function(row) { return row.ReplyActionStatus === 'Awaiting action'; });
  const queued = records_(QB.SHEETS.QUEUE).filter(function(row) {
    return (actor.role === 'Admin' || row.MemberId === actor.memberId) && ['Scheduled', 'Retry'].indexOf(row.Status) >= 0;
  });
  const confirmed = mine.filter(function(row) { return row.PipelineStage === 'Confirmed'; });
  return serialize_({
    summary: { total: mine.length, due: due.length, replies: replies.length, queued: queued.length, confirmed: confirmed.length },
    recent: enrichApproaches_(mine.sort(function(a, b) { return dateValue_(b.UpdatedAt) - dateValue_(a.UpdatedAt); }).slice(0, 8)),
    due: enrichApproaches_(due.sort(function(a, b) { return dateValue_(a.NextFollowUpAt) - dateValue_(b.NextFollowUpAt); }).slice(0, 10)),
    quota: emailCapacity_()
  });
}

function searchCompanies(input, actorInput) {
  const actor = actorFrom_(actorInput); touchSession_(actor);
  const candidates = searchCandidates_(input || {}).map(function(item) {
    item.band = matchBand_(item.score);
    return item;
  });
  logAudit_(actor, 'COMPANY_SEARCHED', 'Company', '', { query: input, candidateCount: candidates.length });
  return serialize_({ candidates: candidates, canCreate: !candidates.some(function(item) { return item.score >= QB.MATCH.REVIEW; }) });
}

function createCompanyAndReserve(payload, actorInput) {
  const actor = actorFrom_(actorInput);
  if (!safeString_(payload.companyName)) throw new Error('Company name is required.');
  return withLock_(function() {
    const candidates = searchCandidates_(payload);
    const blocking = candidates.filter(function(item) {
      return item.score >= QB.MATCH.REVIEW && !hasSeparateApproval_(payload, item.companyId, actor.memberName);
    });
    if (blocking.length && !payload.reviewAcknowledged) {
      blocking.slice(0, 3).forEach(function(candidate) { createDuplicateReview_(payload, candidate, actor); });
      return serialize_({ ok: false, reviewRequired: true, candidates: blocking });
    }
    if (candidates.some(function(item) { return item.score >= QB.MATCH.BLOCK && !hasSeparateApproval_(payload, item.companyId, actor.memberName); })) {
      throw new Error('A strong company match already exists. Use the existing company or ask a director to review it.');
    }

    const companyId = uuid_('CMP');
    const approachId = uuid_('APR');
    const contactId = uuid_('CON');
    const settings = settingsMap_();
    const createdAt = now_();
    const company = {
      CompanyId: companyId,
      DisplayName: safeString_(payload.companyName),
      LegalName: safeString_(payload.legalName),
      NormalizedName: normalizeCompanyName_(payload.companyName),
      Website: safeString_(payload.website),
      Domain: normalizeDomain_(payload.website || payload.email),
      Industry: safeString_(payload.industry),
      EntityType: safeString_(payload.entityType) || 'Company / Brand',
      ParentCompanyId: '',
      DataStatus: payload.email || payload.phone || payload.website ? 'Partial' : 'Basic',
      RecordStatus: 'Active',
      CreatedBy: actor.memberName,
      CreatedAt: createdAt,
      UpdatedAt: createdAt
    };
    appendRows_(QB.SHEETS.COMPANIES, [company]);

    if (payload.contactName || payload.email || payload.phone || payload.socialHandle) {
      appendRows_(QB.SHEETS.CONTACTS, contactRowsFromPayload_(companyId, payload, actor, createdAt));
    }

    const expires = addDays_(createdAt, Number(settings.ReservationDays || 3));
    appendRows_(QB.SHEETS.APPROACHES, [{
      ApproachId: approachId,
      CampaignId: settings.CampaignId,
      CompanyId: companyId,
      OwnerMemberId: actor.memberId,
      OwnerName: actor.memberName,
      PipelineStage: 'Researching',
      ApprovalStatus: 'Approved',
      ReservationAt: createdAt,
      ReservationExpiresAt: expires,
      FollowUpCount: 0,
      Notes: safeString_(payload.notes),
      CreatedAt: createdAt,
      UpdatedAt: createdAt
    }]);
    addInteraction_(approachId, companyId, actor, 'System', 'Internal', 'Company reserved', '', 'Company created and reserved', createdAt);
    logAudit_(actor, 'COMPANY_CREATED_AND_RESERVED', 'Company', companyId, { approachId: approachId, name: company.DisplayName });
    return serialize_({ ok: true, company: company, approachId: approachId });
  });
}

function claimExistingCompany(companyId, actorInput) {
  const actor = actorFrom_(actorInput);
  return withLock_(function() {
    const company = recordById_(QB.SHEETS.COMPANIES, 'CompanyId', companyId);
    if (!company) throw new Error('Company not found.');
    const campaignId = activeCampaignId_();
    const existing = records_(QB.SHEETS.APPROACHES).find(function(row) {
      return row.CampaignId === campaignId && row.CompanyId === companyId && QB.CLOSED_STAGES.indexOf(row.PipelineStage) < 0;
    });
    if (existing) {
      if (existing.OwnerMemberId !== actor.memberId) {
        return serialize_({ ok: false, conflict: true, ownerName: existing.OwnerName, pipelineStage: existing.PipelineStage, approachId: existing.ApproachId });
      }
      return serialize_({ ok: true, approachId: existing.ApproachId, existing: true });
    }
    const settings = settingsMap_();
    const createdAt = now_();
    const approachId = uuid_('APR');
    appendRows_(QB.SHEETS.APPROACHES, [{
      ApproachId: approachId,
      CampaignId: campaignId,
      CompanyId: companyId,
      OwnerMemberId: actor.memberId,
      OwnerName: actor.memberName,
      PipelineStage: 'Researching',
      ApprovalStatus: 'Approved',
      ReservationAt: createdAt,
      ReservationExpiresAt: addDays_(createdAt, Number(settings.ReservationDays || 3)),
      FollowUpCount: 0,
      CreatedAt: createdAt,
      UpdatedAt: createdAt
    }]);
    addInteraction_(approachId, companyId, actor, 'System', 'Internal', 'Company reserved', '', 'Existing company reserved', createdAt);
    logAudit_(actor, 'EXISTING_COMPANY_RESERVED', 'Company', companyId, { approachId: approachId });
    return serialize_({ ok: true, approachId: approachId });
  });
}

function getMyPipeline(actorInput, filter) {
  const actor = actorFrom_(actorInput); touchSession_(actor);
  const campaignId = activeCampaignId_();
  let rows = records_(QB.SHEETS.APPROACHES).filter(function(row) { return row.CampaignId === campaignId; });
  if (actor.role !== 'Admin' && actor.role !== 'Director') rows = rows.filter(function(row) { return row.OwnerMemberId === actor.memberId; });
  if (filter && filter.ownerMemberId && ['Admin', 'Director'].indexOf(actor.role) >= 0) {
    rows = rows.filter(function(row) { return row.OwnerMemberId === filter.ownerMemberId; });
  }
  if (filter && filter.stage) rows = rows.filter(function(row) { return row.PipelineStage === filter.stage; });
  if (filter && filter.dueOnly) rows = rows.filter(function(row) { return row.NextFollowUpAt instanceof Date && row.NextFollowUpAt <= now_(); });
  rows.sort(function(a, b) { return dateValue_(b.UpdatedAt) - dateValue_(a.UpdatedAt); });
  return serialize_(enrichApproaches_(rows.slice(0, 250)));
}

function getTeamProgress(actorInput) {
  const actor = actorFrom_(actorInput); requireRole_(actor, ['Director', 'Admin']);
  const campaignId = activeCampaignId_();
  const approaches = records_(QB.SHEETS.APPROACHES).filter(function(row) { return row.CampaignId === campaignId; });
  const activeMembers = records_(QB.SHEETS.MEMBERS).filter(function(member) {
    return member.Active !== false && String(member.Active).toLowerCase() !== 'false';
  });
  const now = now_();
  const rows = activeMembers.map(function(member) {
    const owned = approaches.filter(function(row) { return row.OwnerMemberId === member.MemberId; });
    const approached = owned.filter(function(row) { return Boolean(row.LastContactAt); });
    const replied = owned.filter(function(row) { return Boolean(row.LastReplyAt); });
    const confirmed = owned.filter(function(row) { return row.PipelineStage === 'Confirmed'; });
    const due = owned.filter(function(row) {
      return row.NextFollowUpAt instanceof Date && row.NextFollowUpAt <= now && QB.CLOSED_STAGES.indexOf(row.PipelineStage) < 0;
    });
    const awaiting = owned.filter(function(row) { return row.ReplyActionStatus === 'Awaiting action'; });
    const deliveryIssues = owned.filter(function(row) {
      return ['Delivery failed', 'Mailbox full'].indexOf(row.LastInboundType) >= 0 && row.SystemActionStatus === 'Needs review';
    });
    const lastActivity = owned.reduce(function(latest, row) {
      return dateValue_(row.UpdatedAt) > dateValue_(latest) ? row.UpdatedAt : latest;
    }, '');
    return {
      memberId: member.MemberId,
      memberName: member.MemberName,
      role: member.Role || 'Member',
      total: owned.length,
      approached: approached.length,
      replied: replied.length,
      awaiting: awaiting.length,
      confirmed: confirmed.length,
      due: due.length,
      deliveryIssues: deliveryIssues.length,
      responseRate: approached.length ? Math.round(replied.length / approached.length * 100) : 0,
      lastActivity: lastActivity
    };
  }).sort(function(a, b) {
    if (b.approached !== a.approached) return b.approached - a.approached;
    return a.memberName.localeCompare(b.memberName);
  });
  const totals = rows.reduce(function(result, row) {
    ['total', 'approached', 'replied', 'awaiting', 'confirmed', 'due', 'deliveryIssues'].forEach(function(key) { result[key] += row[key]; });
    return result;
  }, { total: 0, approached: 0, replied: 0, awaiting: 0, confirmed: 0, due: 0, deliveryIssues: 0 });
  totals.responseRate = totals.approached ? Math.round(totals.replied / totals.approached * 100) : 0;
  return serialize_({ totals: totals, members: rows, generatedAt: now });
}

function submitForApproval(approachId, actorInput) {
  const actor = actorFrom_(actorInput);
  const approach = ownedApproach_(approachId, actor);
  updateById_(QB.SHEETS.APPROACHES, 'ApproachId', approachId, { ApprovalStatus: 'Approved', UpdatedAt: now_() });
  logAudit_(actor, 'APPROACH_SELF_CLEARED', 'Approach', approachId, {});
  return { ok: true };
}

function approveApproach(approachId, actorInput) {
  const actor = actorFrom_(actorInput); requireRole_(actor, ['Director', 'Admin']);
  updateById_(QB.SHEETS.APPROACHES, 'ApproachId', approachId, {
    PipelineStage: 'Approved', ApprovalStatus: 'Approved', ApprovalBy: actor.memberName, ApprovalAt: now_(), UpdatedAt: now_()
  });
  logAudit_(actor, 'APPROACH_APPROVED', 'Approach', approachId, {});
  return { ok: true };
}

function updatePipelineStage(approachId, stage, actorInput) {
  const actor = actorFrom_(actorInput);
  if (QB.PIPELINE.indexOf(stage) < 0) throw new Error('Invalid pipeline stage.');
  const approach = ownedApproach_(approachId, actor);
  updateById_(QB.SHEETS.APPROACHES, 'ApproachId', approachId, { PipelineStage: stage, UpdatedAt: now_(), Outcome: QB.CLOSED_STAGES.indexOf(stage) >= 0 ? stage : approach.Outcome });
  logAudit_(actor, 'PIPELINE_STAGE_UPDATED', 'Approach', approachId, { stage: stage });
  return { ok: true };
}

function recordManualInteraction(payload, actorInput) {
  const actor = actorFrom_(actorInput);
  const approach = ownedApproach_(payload.approachId, actor);
  const occurredAt = payload.occurredAt ? new Date(payload.occurredAt) : now_();
  addInteraction_(approach.ApproachId, approach.CompanyId, actor, payload.channel || 'Other', payload.direction || 'Outgoing', payload.type || 'Note', payload.subject || '', payload.summary || '', occurredAt);
  const patch = { LastContactAt: occurredAt, UpdatedAt: now_() };
  if (payload.nextFollowUpAt) patch.NextFollowUpAt = new Date(payload.nextFollowUpAt);
  if (payload.direction === 'Incoming') {
    patch.PipelineStage = 'Replied';
    if (!payload.nextFollowUpAt) patch.NextFollowUpAt = '';
    patch.LastReplyAt = occurredAt;
  }
  updateById_(QB.SHEETS.APPROACHES, 'ApproachId', approach.ApproachId, patch);
  logAudit_(actor, 'MANUAL_INTERACTION_RECORDED', 'Approach', approach.ApproachId, { channel: payload.channel });
  return { ok: true };
}

function ownedApproach_(approachId, actor) {
  const approach = recordById_(QB.SHEETS.APPROACHES, 'ApproachId', approachId);
  if (!approach) throw new Error('Approach not found.');
  if (approach.OwnerMemberId !== actor.memberId && ['Director', 'Admin'].indexOf(actor.role) < 0) throw new Error('This company is assigned to ' + approach.OwnerName + '.');
  return approach;
}

function enrichApproaches_(approaches) {
  const companies = records_(QB.SHEETS.COMPANIES);
  const contacts = records_(QB.SHEETS.CONTACTS);
  return approaches.map(function(row) {
    const company = companies.find(function(item) { return item.CompanyId === row.CompanyId; }) || {};
    const companyContacts = contacts.filter(function(item) { return item.CompanyId === row.CompanyId && item.ContactStatus !== 'Invalid'; });
    return Object.assign({}, row, {
      CompanyName: company.DisplayName || 'Unknown company',
      Industry: company.Industry || '',
      PrimaryEmail: companyContacts.map(function(item) { return item.Email; }).filter(Boolean)[0] || '',
      PrimaryContact: companyContacts.map(function(item) { return item.ContactName; }).filter(Boolean)[0] || '',
      IsFollowUpDue: row.NextFollowUpAt instanceof Date && row.NextFollowUpAt <= now_() && QB.CLOSED_STAGES.indexOf(row.PipelineStage) < 0
    });
  });
}

function createDuplicateReview_(payload, candidate, actor) {
  const exists = records_(QB.SHEETS.DUPLICATES).some(function(row) {
    return row.Decision === 'Pending' && row.CandidateCompanyId === candidate.companyId && row.SubmittedBy === actor.memberName && row.SubmittedCompanyName === payload.companyName;
  });
  if (exists) return;
  appendRows_(QB.SHEETS.DUPLICATES, [{
    ReviewId: uuid_('DUP'),
    SubmittedCompanyName: safeString_(payload.companyName),
    SubmittedEmail: safeString_(payload.email),
    SubmittedPhone: safeString_(payload.phone),
    CandidateCompanyId: candidate.companyId,
    CandidateName: candidate.displayName,
    MatchScore: candidate.score,
    MatchReasons: candidate.reasons.join(', '),
    ExistingOwner: candidate.ownerName,
    Decision: 'Pending',
    SubmittedBy: actor.memberName,
    SubmittedAt: now_()
  }]);
}

function hasSeparateApproval_(payload, candidateCompanyId, memberName) {
  return records_(QB.SHEETS.DUPLICATES).some(function(row) {
    return row.CandidateCompanyId === candidateCompanyId &&
      normalizeCompanyName_(row.SubmittedCompanyName) === normalizeCompanyName_(payload.companyName) &&
      row.SubmittedBy === memberName && row.Decision === 'Separate company';
  });
}

function getAdminData(actorInput) {
  const actor = actorFrom_(actorInput); requireRole_(actor, ['Director', 'Admin']);
  const pendingApproaches = records_(QB.SHEETS.APPROACHES).filter(function(row) {
    return row.CampaignId === activeCampaignId_() && row.ApprovalStatus === 'Pending';
  });
  const duplicateReviews = records_(QB.SHEETS.DUPLICATES).filter(function(row) { return row.Decision === 'Pending'; });
  const members = records_(QB.SHEETS.MEMBERS);
  return serialize_({
    pendingApproaches: enrichApproaches_(pendingApproaches),
    duplicateReviews: duplicateReviews,
    members: members.map(function(row) { return { memberId: row.MemberId, memberName: row.MemberName, role: row.Role, active: row.Active, notificationEmail: row.NotificationEmail, notifyOnReplies: row.NotifyOnReplies === true || String(row.NotifyOnReplies).toLowerCase() === 'true' }; })
  });
}

function resolveDuplicateReview(reviewId, decision, actorInput) {
  const actor = actorFrom_(actorInput); requireRole_(actor, ['Director', 'Admin']);
  if (['Use existing company', 'Separate company', 'Rejected'].indexOf(decision) < 0) throw new Error('Invalid duplicate-review decision.');
  updateById_(QB.SHEETS.DUPLICATES, 'ReviewId', reviewId, { Decision: decision, ResolvedBy: actor.memberName, ResolvedAt: now_() });
  logAudit_(actor, 'DUPLICATE_REVIEW_RESOLVED', 'DuplicateReview', reviewId, { decision: decision });
  return { ok: true };
}

function addMember(payload, actorInput) {
  const actor = actorFrom_(actorInput); requireRole_(actor, ['Admin']);
  payload = payload || {};
  const memberName = safeString_(payload.memberName);
  const role = safeString_(payload.role) || 'Member';
  const notificationEmail = safeString_(payload.notificationEmail);
  const notifyOnReplies = payload.notifyOnReplies === true || safeString_(payload.notifyOnReplies).toLowerCase() === 'true';
  if (!memberName) throw new Error('Member name is required.');
  if (QB.ROLES.indexOf(role) < 0) throw new Error('Invalid member role.');
  if (notificationEmail && extractEmails_(notificationEmail).length !== 1) throw new Error('Enter one valid reply-notification email address.');
  const existing = records_(QB.SHEETS.MEMBERS).find(function(row) { return safeString_(row.MemberName).toLowerCase() === memberName.toLowerCase(); });
  if (existing) {
    if (notifyOnReplies && !(notificationEmail || safeString_(existing.NotificationEmail))) throw new Error('Enter a notification email before enabling reply alerts.');
    updateById_(QB.SHEETS.MEMBERS, 'MemberId', existing.MemberId, {
      Role: role, Active: true, Email: safeString_(payload.email) || existing.Email,
      Title: safeString_(payload.title) || existing.Title, Phone: safeString_(payload.phone) || existing.Phone,
      SignatureHtml: safeString_(payload.signatureHtml) ? sanitizeEmailHtml_(canonicalizeAssetImageSources_(payload.signatureHtml)) : existing.SignatureHtml,
      SignatureUpdatedAt: safeString_(payload.signatureHtml) ? now_() : existing.SignatureUpdatedAt,
      NotificationEmail: notificationEmail || existing.NotificationEmail,
      NotifyOnReplies: payload.notifyOnReplies === undefined ? existing.NotifyOnReplies : notifyOnReplies
    });
    const updated = recordById_(QB.SHEETS.MEMBERS, 'MemberId', existing.MemberId);
    logAudit_(actor, 'MEMBER_UPDATED', 'Member', existing.MemberId, { name: memberName, role: role });
    return serialize_({ MemberId: updated.MemberId, MemberName: updated.MemberName, Role: updated.Role, WasUpdated: true });
  }
  if (notifyOnReplies && !notificationEmail) throw new Error('Enter a notification email before enabling reply alerts.');
  const member = { MemberId: uuid_('MBR'), MemberName: memberName, Role: role, Active: true, CreatedAt: now_(), Email: safeString_(payload.email), Title: safeString_(payload.title), Phone: safeString_(payload.phone), SignatureHtml: sanitizeEmailHtml_(canonicalizeAssetImageSources_(payload.signatureHtml)), SignatureUpdatedAt: now_(), NotificationEmail: notificationEmail, NotifyOnReplies: notifyOnReplies };
  appendRows_(QB.SHEETS.MEMBERS, [member]);
  logAudit_(actor, 'MEMBER_ADDED', 'Member', member.MemberId, { name: memberName, role: role });
  return serialize_({ MemberId: member.MemberId, MemberName: member.MemberName, Role: member.Role, WasUpdated: false });
}

function setMemberActive(memberId, active, actorInput) {
  const actor = actorFrom_(actorInput); requireRole_(actor, ['Admin']);
  updateById_(QB.SHEETS.MEMBERS, 'MemberId', memberId, { Active: Boolean(active) });
  logAudit_(actor, active ? 'MEMBER_ACTIVATED' : 'MEMBER_DEACTIVATED', 'Member', memberId, {});
  return { ok: true };
}

function getCompanyEditData(approachId, actorInput) {
  const actor = actorFrom_(actorInput);
  const approach = ownedApproach_(approachId, actor);
  return serialize_({
    approach: approach,
    company: recordById_(QB.SHEETS.COMPANIES, 'CompanyId', approach.CompanyId),
    aliases: records_(QB.SHEETS.ALIASES).filter(function(row) { return row.CompanyId === approach.CompanyId; }),
    contacts: records_(QB.SHEETS.CONTACTS).filter(function(row) { return row.CompanyId === approach.CompanyId; })
  });
}

function addCompanyDetails(payload, actorInput) {
  const actor = actorFrom_(actorInput);
  const approach = ownedApproach_(payload.approachId, actor);
  const company = recordById_(QB.SHEETS.COMPANIES, 'CompanyId', approach.CompanyId);
  const contactInput = { email: payload.email, phone: payload.phone, socialHandle: payload.socialHandle };
  const contactClash = searchCandidates_(contactInput).find(function(candidate) {
    return candidate.companyId !== company.CompanyId && candidate.score >= QB.MATCH.BLOCK;
  });
  if (contactClash) throw new Error('This contact detail already belongs to ' + contactClash.displayName + (contactClash.ownerName ? ', owned by ' + contactClash.ownerName : '') + '.');

  return withLock_(function() {
    const changedAt = now_();
    const companyPatch = { UpdatedAt: changedAt };
    if (safeString_(payload.legalName)) companyPatch.LegalName = safeString_(payload.legalName);
    if (safeString_(payload.website)) {
      companyPatch.Website = safeString_(payload.website);
      companyPatch.Domain = normalizeDomain_(payload.website);
    }
    if (safeString_(payload.industry)) companyPatch.Industry = safeString_(payload.industry);
    companyPatch.DataStatus = 'Partial';
    updateById_(QB.SHEETS.COMPANIES, 'CompanyId', company.CompanyId, companyPatch);

    const alias = safeString_(payload.alias);
    if (alias && !records_(QB.SHEETS.ALIASES).some(function(row) {
      return row.CompanyId === company.CompanyId && row.NormalizedAlias === normalizeCompanyName_(alias);
    })) {
      appendRows_(QB.SHEETS.ALIASES, [{ AliasId: uuid_('ALI'), CompanyId: company.CompanyId, Alias: alias, NormalizedAlias: normalizeCompanyName_(alias), CreatedBy: actor.memberName, CreatedAt: changedAt }]);
    }

    if (payload.contactName || payload.email || payload.phone || payload.socialHandle) {
      const normalizedEmail = normalizeEmail_(payload.email);
      const normalizedPhone = normalizePhone_(payload.phone);
      const normalizedSocial = normalizeSocial_(payload.socialHandle);
      const duplicate = records_(QB.SHEETS.CONTACTS).some(function(row) {
        return row.CompanyId === company.CompanyId && (
          (normalizedEmail && row.NormalizedEmail === normalizedEmail) ||
          (normalizedPhone && row.NormalizedPhone === normalizedPhone) ||
          (normalizedSocial && row.NormalizedSocial === normalizedSocial)
        );
      });
      if (!duplicate) appendRows_(QB.SHEETS.CONTACTS, contactRowsFromPayload_(company.CompanyId, payload, actor, changedAt));
    }
    logAudit_(actor, 'COMPANY_DETAILS_ADDED', 'Company', company.CompanyId, { approachId: approach.ApproachId, alias: alias });
    return { ok: true };
  });
}

function contactRowsFromPayload_(companyId, payload, actor, timestamp) {
  const emails = extractEmails_(payload.email);
  const values = emails.length ? emails : [''];
  return values.map(function(email, index) {
    return {
      ContactId: uuid_('CON'), CompanyId: companyId,
      ContactName: safeString_(payload.contactName) || 'General Contact', Department: safeString_(payload.department),
      Email: email, NormalizedEmail: email,
      Phone: index === 0 ? safeString_(payload.phone) : '', NormalizedPhone: index === 0 ? normalizePhone_(payload.phone) : '',
      SocialChannel: index === 0 ? safeString_(payload.socialChannel) : '', SocialHandle: index === 0 ? safeString_(payload.socialHandle) : '', NormalizedSocial: index === 0 ? normalizeSocial_(payload.socialHandle) : '',
      ContactStatus: 'Active', CreatedBy: actor.memberName, CreatedAt: timestamp, UpdatedAt: timestamp
    };
  });
}

function activeTemplates_() {
  return records_(QB.SHEETS.TEMPLATES).filter(function(row) {
    return row.Active !== false && String(row.Active).toLowerCase() !== 'false' && safeString_(row.Status || 'Published') === 'Published' && Boolean(safeString_(row.HtmlBody) || safeString_(row.BodyDriveFileId));
  }).map(function(row) {
    return { templateId: row.TemplateId, name: row.Name, type: row.Type, subject: row.Subject, htmlBody: storedHtmlBody_(row), version: Number(row.Version || 1), defaultAttachmentAssetIds: splitIds_(row.DefaultAttachmentAssetIds) };
  });
}

function getRepliesAwaitingAction(actorInput) {
  const actor = actorFrom_(actorInput); touchSession_(actor);
  let approaches = records_(QB.SHEETS.APPROACHES).filter(function(row) { return row.CampaignId === activeCampaignId_(); });
  if (actor.role !== 'Admin' && actor.role !== 'Director') approaches = approaches.filter(function(row) { return row.OwnerMemberId === actor.memberId; });
  const human = approaches.filter(function(row) { return row.ReplyActionStatus === 'Awaiting action'; });
  const automated = approaches.filter(function(row) { return row.SystemActionStatus === 'Needs review'; });
  human.sort(function(a, b) { return dateValue_(b.LastReplyAt) - dateValue_(a.LastReplyAt); });
  automated.sort(function(a, b) { return dateValue_(b.LastInboundAt) - dateValue_(a.LastInboundAt); });
  return serialize_({ humanReplies: enrichApproaches_(human), automatedResponses: enrichApproaches_(automated) });
}

function getEmailQueue(actorInput) {
  const actor = actorFrom_(actorInput); touchSession_(actor);
  let rows = records_(QB.SHEETS.QUEUE);
  if (actor.role !== 'Admin' && actor.role !== 'Director') rows = rows.filter(function(row) { return row.MemberId === actor.memberId; });
  const companies = records_(QB.SHEETS.COMPANIES);
  rows.sort(function(a, b) { return dateValue_(b.CreatedAt) - dateValue_(a.CreatedAt); });
  return serialize_(rows.slice(0, 150).map(function(row) {
    const company = companies.find(function(item) { return item.CompanyId === row.CompanyId; }) || {};
    return Object.assign({}, row, { CompanyName: company.DisplayName || 'Unknown company' });
  }));
}

function cancelQueuedEmail(queueId, actorInput) {
  const actor = actorFrom_(actorInput);
  const row = recordById_(QB.SHEETS.QUEUE, 'QueueId', queueId);
  if (!row) throw new Error('Queued email not found.');
  if (row.MemberId !== actor.memberId && ['Director', 'Admin'].indexOf(actor.role) < 0) throw new Error('This email was queued by ' + row.MemberName + '.');
  if (['Scheduled', 'Retry'].indexOf(row.Status) < 0) throw new Error('Only scheduled or retrying emails can be cancelled.');
  updateById_(QB.SHEETS.QUEUE, 'QueueId', queueId, { Status: 'Cancelled', UpdatedAt: now_() });
  logAudit_(actor, 'EMAIL_CANCELLED', 'EmailQueue', queueId, {});
  return { ok: true };
}

function getSchedulerStatus(actorInput) {
  actorFrom_(actorInput);
  const triggerActive = ScriptApp.getProjectTriggers().some(function(trigger) { return trigger.getHandlerFunction() === 'processScheduledEmails'; });
  return serialize_({ active: triggerActive, lastRunAt: getSetting_('LastQueueRunAt') || '', timezone: getSetting_('Timezone') || 'Asia/Kuala_Lumpur' });
}

function repairEmailScheduler(actorInput) {
  const actor = actorFrom_(actorInput);
  createAutomationTriggers();
  logAudit_(actor, 'EMAIL_SCHEDULER_REPAIRED', 'Trigger', 'processScheduledEmails', {});
  return getSchedulerStatus(actorInput);
}

function runEmailQueueNow(actorInput) {
  const actor = actorFrom_(actorInput);
  const result = processScheduledEmails();
  logAudit_(actor, 'EMAIL_QUEUE_RUN_MANUALLY', 'EmailQueue', '', result);
  return serialize_(result);
}

function markReplyHandled(approachId, nextStage, actorInput) {
  const actor = actorFrom_(actorInput);
  ownedApproach_(approachId, actor);
  const stage = QB.PIPELINE.indexOf(nextStage) >= 0 ? nextStage : 'Negotiating';
  updateById_(QB.SHEETS.APPROACHES, 'ApproachId', approachId, { PipelineStage: stage, ReplyActionStatus: 'Handled', UpdatedAt: now_() });
  logAudit_(actor, 'REPLY_HANDLED', 'Approach', approachId, { stage: stage });
  return { ok: true };
}

function markSystemResponseHandled(approachId, actorInput) {
  const actor = actorFrom_(actorInput);
  ownedApproach_(approachId, actor);
  updateById_(QB.SHEETS.APPROACHES, 'ApproachId', approachId, { SystemActionStatus: 'Reviewed', UpdatedAt: now_() });
  logAudit_(actor, 'SYSTEM_RESPONSE_REVIEWED', 'Approach', approachId, {});
  return { ok: true };
}

function getMySignature(actorInput) {
  const actor = actorFrom_(actorInput);
  return serialize_(memberEmailProfile_(actor.memberId));
}

function updateMySignature(payload, actorInput) {
  const actor = actorFrom_(actorInput);
  const html = sanitizeEmailHtml_(canonicalizeAssetImageSources_(payload.signatureHtml));
  const notificationEmail = safeString_(payload.notificationEmail);
  const notifyOnReplies = payload.notifyOnReplies === true || safeString_(payload.notifyOnReplies).toLowerCase() === 'true';
  if (notificationEmail && extractEmails_(notificationEmail).length !== 1) throw new Error('Enter one valid reply-notification email address.');
  if (notifyOnReplies && !notificationEmail) throw new Error('Enter a notification email before enabling reply alerts.');
  validateAssetReferences_(html);
  updateById_(QB.SHEETS.MEMBERS, 'MemberId', actor.memberId, { Email: safeString_(payload.email), Title: safeString_(payload.title), Phone: safeString_(payload.phone), SignatureHtml: html, SignatureUpdatedAt: now_(), NotificationEmail: notificationEmail, NotifyOnReplies: notifyOnReplies });
  logAudit_(actor, 'SIGNATURE_UPDATED', 'Member', actor.memberId, {});
  return { ok: true };
}

function addEmailTemplate(payload, actorInput) {
  return saveEmailTemplate(payload, actorInput);
}

function addInteraction_(approachId, companyId, actor, channel, direction, type, subject, summary, occurredAt, gmail) {
  appendRows_(QB.SHEETS.INTERACTIONS, [{
    InteractionId: uuid_('INT'), ApproachId: approachId, CompanyId: companyId,
    MemberId: actor ? actor.memberId : 'SYSTEM', MemberName: actor ? actor.memberName : 'System',
    Channel: channel, Direction: direction, Type: type, Subject: subject, Summary: summary,
    GmailThreadId: gmail && gmail.threadId || '', GmailMessageId: gmail && gmail.messageId || '',
    OccurredAt: occurredAt || now_(), CreatedAt: now_()
  }]);
}

function dateValue_(value) {
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function addDays_(date, days) {
  const copy = new Date(date.getTime()); copy.setDate(copy.getDate() + days); return copy;
}
