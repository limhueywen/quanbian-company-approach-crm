const QB = Object.freeze({
  VERSION: '2.6.0',
  CREATOR: 'Lim Huey Wen',
  PROP_SPREADSHEET_ID: 'QB_SPREADSHEET_ID',
  SHEETS: Object.freeze({
    SETTINGS: 'Settings',
    MEMBERS: 'Members',
    COMPANIES: 'Companies',
    ALIASES: 'CompanyAliases',
    CONTACTS: 'Contacts',
    APPROACHES: 'Approaches',
    INTERACTIONS: 'Interactions',
    TEMPLATES: 'EmailTemplates',
    ASSETS: 'EmailAssets',
    QUEUE: 'EmailQueue',
    DUPLICATES: 'DuplicateReview',
    SESSIONS: 'DeviceSessions',
    AUDIT: 'AuditLog'
  }),
  HEADERS: Object.freeze({
    Settings: ['Key', 'Value', 'Description'],
    Members: ['MemberId', 'MemberName', 'Role', 'Active', 'CreatedAt', 'Email', 'Title', 'Phone', 'SignatureHtml', 'LegacySignatureSource', 'SignatureUpdatedAt', 'NotificationEmail', 'NotifyOnReplies'],
    Companies: ['CompanyId', 'DisplayName', 'LegalName', 'NormalizedName', 'Website', 'Domain', 'Industry', 'EntityType', 'ParentCompanyId', 'DataStatus', 'RecordStatus', 'CreatedBy', 'CreatedAt', 'UpdatedAt'],
    CompanyAliases: ['AliasId', 'CompanyId', 'Alias', 'NormalizedAlias', 'CreatedBy', 'CreatedAt'],
    Contacts: ['ContactId', 'CompanyId', 'ContactName', 'Department', 'Email', 'NormalizedEmail', 'Phone', 'NormalizedPhone', 'SocialChannel', 'SocialHandle', 'NormalizedSocial', 'ContactStatus', 'CreatedBy', 'CreatedAt', 'UpdatedAt'],
    Approaches: ['ApproachId', 'CampaignId', 'CompanyId', 'OwnerMemberId', 'OwnerName', 'PipelineStage', 'ApprovalStatus', 'ApprovalBy', 'ApprovalAt', 'ReservationAt', 'ReservationExpiresAt', 'LastContactAt', 'LastReplyAt', 'NextFollowUpAt', 'FollowUpCount', 'GmailThreadId', 'GmailMessageId', 'Outcome', 'Notes', 'CreatedAt', 'UpdatedAt', 'LastReplyFrom', 'ReplySnippet', 'ReplyActionStatus', 'LastInboundType', 'LastInboundAt', 'LastInboundFrom', 'LastInboundSnippet', 'SystemActionStatus'],
    Interactions: ['InteractionId', 'ApproachId', 'CompanyId', 'MemberId', 'MemberName', 'Channel', 'Direction', 'Type', 'Subject', 'Summary', 'GmailThreadId', 'GmailMessageId', 'OccurredAt', 'CreatedAt'],
    EmailTemplates: ['TemplateId', 'Name', 'Type', 'Subject', 'HtmlBody', 'Active', 'UpdatedAt', 'LegacyDocumentSource', 'LegacyRichSource', 'Version', 'Status', 'DefaultAttachmentAssetIds', 'UpdatedBy', 'CreatedAt', 'BodyDriveFileId'],
    EmailAssets: ['AssetId', 'Name', 'AssetType', 'MimeType', 'DriveFileId', 'FileName', 'AltText', 'WebsiteUrl', 'Active', 'UploadedBy', 'CreatedAt', 'UpdatedAt'],
    EmailQueue: ['QueueId', 'ApproachId', 'CompanyId', 'MemberId', 'MemberName', 'Mode', 'TemplateId', 'To', 'Cc', 'Bcc', 'ContactName', 'Subject', 'HtmlBody', 'AttachmentLinks', 'ScheduledAt', 'Status', 'Attempts', 'LastError', 'GmailThreadId', 'GmailMessageId', 'CreatedAt', 'SentAt', 'UpdatedAt', 'AttachmentFileIds', 'LegacyTemplateSource', 'LegacySignatureSource', 'InlineAssetIds', 'TemplateVersion', 'HtmlBodyFileId'],
    DuplicateReview: ['ReviewId', 'SubmittedCompanyName', 'SubmittedEmail', 'SubmittedPhone', 'CandidateCompanyId', 'CandidateName', 'MatchScore', 'MatchReasons', 'ExistingOwner', 'Decision', 'SubmittedBy', 'SubmittedAt', 'ResolvedBy', 'ResolvedAt'],
    DeviceSessions: ['SessionId', 'MemberId', 'MemberName', 'DeviceSummary', 'UserAgent', 'Timezone', 'ScreenSize', 'FirstSeenAt', 'LastSeenAt', 'RevokedAt'],
    AuditLog: ['AuditId', 'MemberId', 'MemberName', 'SessionId', 'DeviceSummary', 'Action', 'EntityType', 'EntityId', 'DetailsJson', 'OccurredAt']
  }),
  PIPELINE: Object.freeze(['Researching', 'Ready for Review', 'Approved', 'Contacted', 'Replied', 'Negotiating', 'Confirmed', 'Rejected', 'Closed']),
  CLOSED_STAGES: Object.freeze(['Confirmed', 'Rejected', 'Closed']),
  APPROVALS: Object.freeze(['Not Submitted', 'Pending', 'Approved', 'Returned']),
  ROLES: Object.freeze(['Member', 'Director', 'Admin']),
  MATCH: Object.freeze({ BLOCK: 90, REVIEW: 72, SHOW: 48 }),
  LOCK_TIMEOUT_MS: 30000
});

function now_() {
  return new Date();
}

function uuid_(prefix) {
  return prefix + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 12).toUpperCase();
}

function safeString_(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function activeCampaignId_() {
  return getSetting_('CampaignId') || 'CAMPAIGN-CURRENT';
}
