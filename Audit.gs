function memberById_(memberId) {
  const member = recordById_(QB.SHEETS.MEMBERS, 'MemberId', memberId);
  if (!member || member.Active === false || String(member.Active).toLowerCase() === 'false') {
    throw new Error('Select an active committee member before continuing.');
  }
  return member;
}

function actorFrom_(actor) {
  if (!actor || !actor.memberId) throw new Error('Select your committee name before continuing.');
  const member = memberById_(actor.memberId);
  return {
    memberId: member.MemberId,
    memberName: member.MemberName,
    role: member.Role || 'Member',
    sessionId: safeString_(actor.sessionId),
    deviceSummary: safeString_(actor.deviceSummary)
  };
}

function requireRole_(actor, allowed) {
  if (allowed.indexOf(actor.role) < 0) throw new Error('This action requires Director or Admin access.');
}

function logAudit_(actor, action, entityType, entityId, details) {
  appendRows_(QB.SHEETS.AUDIT, [{
    AuditId: uuid_('AUD'),
    MemberId: actor ? actor.memberId : 'SYSTEM',
    MemberName: actor ? actor.memberName : 'System',
    SessionId: actor ? actor.sessionId : 'TRIGGER',
    DeviceSummary: actor ? actor.deviceSummary : 'Apps Script trigger',
    Action: action,
    EntityType: entityType,
    EntityId: entityId,
    DetailsJson: JSON.stringify(details || {}),
    OccurredAt: now_()
  }]);
}

function startMemberSession(memberId, session) {
  const member = memberById_(memberId);
  const sessionId = safeString_(session && session.sessionId) || uuid_('SES');
  const existing = recordById_(QB.SHEETS.SESSIONS, 'SessionId', sessionId);
  const summary = safeString_(session && session.deviceSummary);
  if (existing) {
    updateById_(QB.SHEETS.SESSIONS, 'SessionId', sessionId, {
      MemberId: member.MemberId,
      MemberName: member.MemberName,
      DeviceSummary: summary,
      UserAgent: safeString_(session && session.userAgent),
      Timezone: safeString_(session && session.timezone),
      ScreenSize: safeString_(session && session.screenSize),
      LastSeenAt: now_(), RevokedAt: ''
    });
  } else {
    appendRows_(QB.SHEETS.SESSIONS, [{
      SessionId: sessionId,
      MemberId: member.MemberId,
      MemberName: member.MemberName,
      DeviceSummary: summary,
      UserAgent: safeString_(session && session.userAgent),
      Timezone: safeString_(session && session.timezone),
      ScreenSize: safeString_(session && session.screenSize),
      FirstSeenAt: now_(),
      LastSeenAt: now_(), RevokedAt: ''
    }]);
  }
  const actor = { memberId: member.MemberId, memberName: member.MemberName, role: member.Role, sessionId: sessionId, deviceSummary: summary };
  logAudit_(actor, 'MEMBER_SELECTED', 'Member', member.MemberId, { role: member.Role });
  return serialize_({ sessionId: sessionId, member: { MemberId: member.MemberId, MemberName: member.MemberName, Role: member.Role } });
}

function touchSession_(actor) {
  return actor;
}

function endMemberSession(actorInput) {
  const actor = actorFrom_(actorInput);
  logAudit_(actor, 'MEMBER_SWITCH_REQUESTED', 'Member', actor.memberId, {});
  return { ok: true };
}
