function normalizeCompanyName_(value) {
  let text = safeString_(value).toLowerCase();
  if (!text) return '';
  try { text = text.normalize('NFKC'); } catch (ignore) {}
  text = text
    .replace(/&/g, ' and ')
    .replace(/\b(sendirian\s+berhad|sdn\.?\s*bhd\.?|berhad|bhd\.?|limited|ltd\.?|plc|llp|plt)\b/gi, ' ')
    .replace(/\b(malaysia|malaysian)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
  return text;
}

function normalizeEmail_(value) {
  const emails = extractEmails_(value);
  return emails.length ? emails[0] : '';
}

function extractEmails_(value) {
  const matches = safeString_(value).toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/g) || [];
  return Array.from(new Set(matches.map(function(item) { return item.trim(); })));
}

function normalizePhone_(value) {
  let digits = safeString_(value).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.indexOf('0060') === 0) digits = digits.slice(2);
  if (digits.indexOf('60') === 0) return digits;
  if (digits.indexOf('0') === 0) return '60' + digits.slice(1);
  if (digits.length >= 9 && digits.length <= 11) return '60' + digits;
  return digits;
}

function normalizeSocial_(value) {
  return safeString_(value).toLowerCase().replace(/^@/, '').replace(/\s+/g, '');
}

function normalizeDomain_(value) {
  let text = safeString_(value).toLowerCase();
  if (!text) return '';
  const email = normalizeEmail_(text);
  if (email) return email.split('@')[1];
  text = text.replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  return text.replace(/:\d+$/, '');
}

function nameTokens_(value) {
  let text = safeString_(value).toLowerCase();
  try { text = text.normalize('NFKC'); } catch (ignore) {}
  return Array.from(new Set(text
    .replace(/&/g, ' and ')
    .replace(/\b(sendirian|berhad|sdn|bhd|limited|ltd|malaysia|the|and)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter(function(token) { return token.length > 1; })));
}

function levenshtein_(a, b) {
  a = safeString_(a); b = safeString_(b);
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const previous = Array.from({ length: b.length + 1 }, function(_, i) { return i; });
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    for (let j = 0; j < current.length; j++) previous[j] = current[j];
  }
  return previous[b.length];
}

function textSimilarity_(a, b) {
  a = normalizeCompanyName_(a); b = normalizeCompanyName_(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const distance = levenshtein_(a, b);
  return Math.max(0, 1 - distance / Math.max(a.length, b.length));
}

function tokenSimilarity_(a, b) {
  const left = nameTokens_(a); const right = nameTokens_(b);
  if (!left.length || !right.length) return 0;
  const intersection = left.filter(function(token) { return right.indexOf(token) >= 0; }).length;
  const union = new Set(left.concat(right)).size;
  return union ? intersection / union : 0;
}

function matchCompany_(input, company, aliases, contacts) {
  let score = 0;
  const reasons = [];
  const inputName = safeString_(input.companyName || input.query);
  const inputEmail = normalizeEmail_(input.email || input.query);
  const inputPhone = normalizePhone_(input.phone || input.query);
  const inputDomain = normalizeDomain_(input.website || input.email || input.query);
  const inputSocial = normalizeSocial_(input.socialHandle || '');
  const companyNames = [company.DisplayName, company.LegalName].concat(aliases.map(function(alias) { return alias.Alias; }));
  const companyContacts = contacts || [];

  if (inputEmail && companyContacts.some(function(contact) { return contact.NormalizedEmail === inputEmail; })) {
    score = 100; reasons.push('Exact email');
  }
  if (inputPhone && companyContacts.some(function(contact) { return contact.NormalizedPhone === inputPhone; })) {
    score = Math.max(score, 100); reasons.push('Exact phone');
  }
  if (inputSocial && companyContacts.some(function(contact) { return contact.NormalizedSocial === inputSocial; })) {
    score = Math.max(score, 98); reasons.push('Exact social account');
  }
  if (inputDomain && company.Domain && inputDomain === company.Domain) {
    score = Math.max(score, 92); reasons.push('Same website domain');
  }

  if (inputName) {
    companyNames.filter(Boolean).forEach(function(name) {
      if (normalizeCompanyName_(inputName) === normalizeCompanyName_(name)) {
        score = Math.max(score, name === company.DisplayName ? 96 : 94);
        if (reasons.indexOf('Exact company name or alias') < 0) reasons.push('Exact company name or alias');
      } else {
        const character = textSimilarity_(inputName, name);
        const tokens = tokenSimilarity_(inputName, name);
        const fuzzy = Math.round(Math.max(character * 84, tokens * 82));
        if (fuzzy > score) score = fuzzy;
      }
    });
    if (score >= QB.MATCH.SHOW && !reasons.length) reasons.push('Similar company name');
  }

  return { score: score, reasons: reasons };
}

function searchCandidates_(input) {
  const companies = records_(QB.SHEETS.COMPANIES).filter(function(row) { return row.RecordStatus !== 'Merged'; });
  const aliases = records_(QB.SHEETS.ALIASES);
  const contacts = records_(QB.SHEETS.CONTACTS).filter(function(row) { return row.ContactStatus !== 'Invalid'; });
  const campaignId = activeCampaignId_();
  const approaches = records_(QB.SHEETS.APPROACHES).filter(function(row) { return String(row.CampaignId) === String(campaignId); });

  return companies.map(function(company) {
    const companyAliases = aliases.filter(function(row) { return row.CompanyId === company.CompanyId; });
    const companyContacts = contacts.filter(function(row) { return row.CompanyId === company.CompanyId; });
    const match = matchCompany_(input, company, companyAliases, companyContacts);
    if (match.score < QB.MATCH.SHOW) return null;
    const approach = approaches.find(function(row) { return row.CompanyId === company.CompanyId && QB.CLOSED_STAGES.indexOf(row.PipelineStage) < 0; }) ||
      approaches.find(function(row) { return row.CompanyId === company.CompanyId; });
    return {
      companyId: company.CompanyId,
      displayName: company.DisplayName,
      legalName: company.LegalName,
      industry: company.Industry,
      domain: company.Domain,
      score: match.score,
      reasons: match.reasons,
      ownerName: approach ? approach.OwnerName : '',
      pipelineStage: approach ? approach.PipelineStage : '',
      approvalStatus: approach ? approach.ApprovalStatus : '',
      approachId: approach ? approach.ApproachId : '',
      lastContactAt: approach ? approach.LastContactAt : '',
      contacts: companyContacts.slice(0, 3).map(function(contact) {
        return { name: contact.ContactName, email: contact.Email, phone: contact.Phone };
      })
    };
  }).filter(Boolean).sort(function(a, b) { return b.score - a.score; }).slice(0, 8);
}

function matchBand_(score) {
  if (score >= QB.MATCH.BLOCK) return 'Confirmed or strong clash';
  if (score >= QB.MATCH.REVIEW) return 'Review required';
  return 'Possible match';
}
