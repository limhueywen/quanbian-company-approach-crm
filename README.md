# 全辩 Company Approach CRM

Beginner-friendly company outreach, email scheduling and reply tracking for a committee using one shared Marketing Gmail account.

**Current version:** 2.6.0  
**Created by:** Lim Huey Wen  
**Platform:** Google Sheets, Google Apps Script, Gmail API and Google Drive

> This repository contains the application source code only. Company records, contacts, email content, Gmail messages and uploaded assets remain in the Google account that installs the CRM.

## What this CRM solves

Committee outreach becomes difficult when the company database and email sender are separate. Members cannot easily see whether a company has already been claimed, contacted, replied, rejected or scheduled for follow-up.

This CRM keeps the workflow together:

- checks company names, aliases, emails, domains, phone numbers, websites and social accounts for possible duplicates;
- assigns each company to one committee member;
- records the selected committee identity and browser session for each action;
- sends individual or personalized bulk emails from one shared Gmail account;
- schedules emails through a shared queue;
- stores visual email templates, signatures, images and PDF attachments;
- detects replies, delivery failures, mailbox-full notices, out-of-office messages and automatic acknowledgements;
- tracks follow-ups, pipeline stages and committee progress;
- keeps an audit trail of searches, claims, uploads, template changes and sends.

## Intended operating model

- One normal `@gmail.com` account owns the Google Sheet, Apps Script project, Drive assets and web-app deployment.
- The web app is restricted to that Google account.
- Committee members open the CRM through the shared account and select their own name.
- Members can claim companies and send or schedule their own outreach without waiting for Director approval.
- Directors and Administrators can review team progress, all companies, replies, templates and duplicate warnings.
- Historical Excel files remain read-only references. Members manually add historical companies when needed.

## Main features

### Company database

- One company record with multiple aliases and contacts
- Duplicate detection across English and Chinese names
- Email, domain, phone, website and social-account matching
- Company owner, pipeline stage, outcome and follow-up date
- Director review for uncertain matches

### Email operations

- Visual email template editor
- Times New Roman, KaiTi and Arial
- Formatting, links, tables and personalization fields
- Custom email types beyond First Approach and Follow-up
- Reusable linked images and logo assets
- Actual PDF attachments instead of Drive links
- Individual and personalized bulk sending
- Scheduled sending with locked message snapshots
- Per-member visual signatures

### Inbox and management

- Human replies awaiting action
- Automated responses and delivery issues in a separate queue
- Gmail labels for outstanding replies and delivery problems
- Optional reply notifications to personal email addresses
- Team progress dashboard for Directors and Administrators
- Device-session and audit history

## Before you begin

You need:

1. A Google account that will act as the shared Marketing Gmail.
2. A blank Google Sheet owned by that account.
3. Permission to use Gmail, Google Drive, Google Sheets and Apps Script.
4. The source files from this repository.
5. About 20-30 minutes for the first installation.

No paid hosting, external database or AppSheet subscription is required. Google account quotas and anti-abuse rules still apply.

## Project files

Create these files in Apps Script using the exact names shown.

| Repository file | Apps Script file type | Apps Script name |
|---|---|---|
| `Api.gs` | Script | `Api` |
| `Audit.gs` | Script | `Audit` |
| `Config.gs` | Script | `Config` |
| `Database.gs` | Script | `Database` |
| `EmailStudio.gs` | Script | `EmailStudio` |
| `GmailService.gs` | Script | `GmailService` |
| `Matching.gs` | Script | `Matching` |
| `Index.html` | HTML | `Index` |
| `Styles.html` | HTML | `Styles` |
| `App.html` | HTML | `App` |
| `appsscript.json` | Manifest | `appsscript.json` |

The `tests` folder, `DESIGN.md`, `PRODUCT.md` and `.clasp.json.example` are for development and documentation. Do not paste them into the Apps Script editor.

## First-time installation

### Prepare the shared Google account

1. Sign in to the Gmail account that will own and send all CRM emails.
2. Do not install the project from a personal committee member's account.
3. Create a Drive folder for backups if desired. The CRM creates its own private asset folders automatically.

### Create the database Sheet

1. Open [Google Sheets](https://sheets.google.com).
2. Create a blank spreadsheet.
3. Rename it, for example, `全辩 Company CRM Database`.
4. Keep it private to the shared Marketing account unless another administrator genuinely needs editor access.

### Open the Apps Script project

1. In the spreadsheet, select **Extensions > Apps Script**.
2. Rename the Apps Script project, for example, `全辩 Company Approach CRM`.
3. Delete the default sample function from `Code.gs`.
4. Rename `Code.gs` to `Api`, or delete it after creating `Api`.

### Copy the script files

For every `.gs` file:

1. Click the plus button beside **Files**.
2. Choose **Script**.
3. Enter the filename without `.gs`, such as `Config`.
4. Open the matching repository file.
5. Copy all its content into Apps Script.

For every `.html` file:

1. Click the plus button beside **Files**.
2. Choose **HTML**.
3. Enter the filename without `.html`, such as `Index`.
4. Copy all content from the matching repository file.

Do not mix files from different releases. `Api.gs`, `Index.html` and `App.html` must always come from the same version.

### Replace the manifest

1. In Apps Script, open **Project Settings**.
2. Enable **Show `appsscript.json` manifest file in editor**.
3. Return to **Editor** and open `appsscript.json`.
4. Replace its complete content with this repository's `appsscript.json`.
5. Save the project.

The manifest enables the Gmail API v1 advanced service and declares the required OAuth permissions.

### Verify the Gmail service

1. In the Apps Script editor, find **Services** in the left sidebar.
2. Confirm that **Gmail API** is listed.
3. If it is missing, click **Add a service**, select **Gmail API**, choose version `v1`, then click **Add**.

For the default Cloud project created by Apps Script, adding the advanced service normally enables the corresponding API automatically. A standard Google Cloud project may require the Gmail API to be enabled separately.

### Create the database

1. Select `setupSystem` from the Apps Script function menu.
2. Click **Run**.
3. Select the shared Marketing account when Google requests permission.
4. Review and approve the requested access.
5. Wait until the execution log shows that the function completed.
6. Return to the spreadsheet and confirm that the CRM sheets were created.

`setupSystem()` creates missing sheets, headers, default settings, an Administrator identity, starter templates and automation triggers. Running it again is safe: it adds missing schema items without deleting normal CRM records.

### Confirm all permissions

1. Select `authorizeSystem` from the function menu.
2. Click **Run**.
3. Approve any additional Gmail, Drive, Sheets or trigger permissions.
4. Confirm that the execution completes without an exception.

Run `authorizeSystem()` again after an update if the project begins using a new Google service or permission.

### Deploy the web app

1. Click **Deploy > New deployment**.
2. Click **Select type > Web app**.
3. Enter a description such as `Initial CRM deployment`.
4. Set **Execute as** to **Me**.
5. Set **Who has access** to **Only myself**.
6. Click **Deploy**.
7. Copy the web-app URL ending in `/exec`.
8. Bookmark that URL while signed in to the shared Marketing account.

Do not use the `/dev` test URL for normal committee work. It is intended for editors and always runs the latest saved code.

## First login and configuration

### Enter the CRM

1. Open the deployed `/exec` URL.
2. Choose `Marketing Administrator`.
3. Click **Continue to CRM**.

The name selector is not a separate Google login. Google access is controlled by the shared account, while the selected name identifies the committee member responsible for each CRM action.

### Add committee members

1. Open **Admin review**.
2. Enter the member's name, role, title, contact email and phone.
3. Add a personal notification email only if the member wants reply alerts.
4. Click **Add or update member**.

Entering an existing name updates that member instead of creating another active identity.

### Add the CRM logo

1. Open **Template studio**.
2. Upload a PNG, JPG, GIF or WebP image in the Asset Library.
3. Find the image and click **Use as CRM logo**.

Transparent PNG margins are trimmed in the browser. The logo keeps its original aspect ratio instead of being stretched into a fixed rectangle. The interface logo must be 2 MB or smaller.

### Create email templates

1. Open **Template studio** as a Director or Administrator.
2. Click **New**.
3. Enter a template name, email type and subject.
4. Choose an existing email type or type a new one.
5. Write or paste the email in the visual editor.
6. Insert personalization fields from **Insert field**.
7. Upload images and click **Insert** beside the required asset.
8. Click an inserted logo and choose **Fit logo** when appropriate.
9. Upload proposal PDFs and select them under **Default PDF attachments**.
10. Preview the template and send a test email.
11. Save it as Draft while editing, then Publish it for members.

Available fields:

- `{{CompanyName}}`
- `{{LegalName}}`
- `{{ContactName}}`
- `{{CampaignName}}`
- `{{MemberName}}`
- `{{MemberTitle}}`
- `{{MemberPhone}}`
- `{{MemberEmail}}`
- `{{MemberSignature}}`

### Create each member's signature

1. Select the member's identity.
2. Click **My email signature** in the sidebar.
3. Enter the member's title, email and phone.
4. Design the signature in the visual editor.
5. Upload a new logo or click **Insert** beside a saved image.
6. Add the official website URL during upload if the logo should be clickable.
7. Click the image and choose **Fit logo**, another preset, or Custom sizing.
8. Click **Save signature**.

New PNG uploads have transparent outer margins removed before storage. Re-upload older PNG assets once if they were stored before this feature existed.

## Normal committee workflow

### Add or claim a company

1. Select **Add company**.
2. Enter every detail the member knows.
3. Run the clash check.
4. Review exact and similar matches carefully.
5. Claim the existing company when it is the same organization.
6. Create a new company only when it is genuinely different.

### Send one email

1. Open **My pipeline** or **All companies**.
2. Find the company and click **Email**.
3. Select the email type and template.
4. Confirm the recipient, contact name and subject.
5. Add extra PDF attachments if required.
6. Choose **Send now** or **Schedule**.
7. Confirm the action.

### Send personalized bulk email

1. Open the company pipeline.
2. Select companies with valid email addresses.
3. Click **Bulk email selected**.
4. Select the template.
5. Review the subject and body.
6. Send now or schedule the batch.

Every company receives a separate personalized message. Recipient addresses are not exposed to other companies.

### Process replies

- The automatic Gmail scan runs approximately every five minutes.
- Click **Sync Gmail now** for an immediate check.
- Human replies appear under **Inbox review**.
- Delivery failures, mailbox-full notices, out-of-office messages and acknowledgements appear separately.
- Mark an item handled after the responsible member has acted on it.
- Test reply tracking from a different email account. Messages sent from the same shared Gmail are ignored.

Gmail can take time to index a newly received message. If an immediate scan finds nothing, wait about one minute and scan again.

## Scheduling and automation

`setupSystem()` installs these time-driven triggers:

| Function | Frequency | Purpose |
|---|---:|---|
| `processScheduledEmails` | Every minute | Sends due queued emails |
| `syncGmailReplies` | Every 5 minutes | Checks tracked Gmail conversations |
| `expireUnusedReservations` | Daily | Releases unused company reservations |

Apps Script triggers are approximate. A scheduled email may be sent shortly after the selected minute.

If scheduling stops, open **Email queue** and use **Repair scheduler**, or run `createAutomationTriggers()` in Apps Script.

## Database sheets

| Sheet | Purpose |
|---|---|
| `Settings` | Campaign name, limits, follow-up timing and scheduler status |
| `Members` | Committee identities, contact details and signatures |
| `Companies` | Main company and legal-entity records |
| `CompanyAliases` | Alternative names linked to companies |
| `Contacts` | Email, phone and social contacts used for clash checking |
| `Approaches` | Ownership, pipeline stage, follow-ups and Gmail tracking |
| `Interactions` | Email, call, social and internal activity history |
| `EmailTemplates` | Template metadata, status, version and assets |
| `EmailAssets` | Uploaded images, linked logos and reusable PDFs |
| `EmailQueue` | Scheduled message snapshots and delivery status |
| `DuplicateReview` | Similar records awaiting a decision |
| `DeviceSessions` | Selected member and browser-session information |
| `AuditLog` | Searches, claims, uploads, changes and sends |

Do not manually change ID columns or normalized matching fields unless you understand the code that uses them.

## File and sending limits

- Interface logo: maximum 2 MB
- Email image: maximum 5 MB
- PDF asset: maximum 20 MB
- Additional PDFs for one send: maximum 20 MB total
- Google Sheets cells: maximum 50,000 characters, so long HTML is stored in private Drive files
- CRM daily send safety setting: 450 recipients by default

The CRM estimate does not increase Google's actual Gmail limits. Manually sent Gmail messages also consume account capacity but are not included in the CRM estimate. Google may restrict sending based on volume, recipient quality, complaint rate or anti-abuse signals.

For consistently higher legitimate volume, use Google Workspace or a compliant transactional or campaign email provider. Do not rotate personal accounts to evade restrictions.

## Updating an existing installation

1. Make a backup copy of the Google Sheet.
2. Download the new source release.
3. Replace every project file, including `appsscript.json`.
4. Confirm the version in `Config.gs`.
5. Save the project.
6. Run `setupSystem()` if the release notes mention schema changes. It is safe to run for normal upgrades.
7. Run `authorizeSystem()` if permissions or Google services changed.
8. Open **Deploy > Manage deployments**.
9. Edit the existing web-app deployment.
10. Select **New version**, then deploy.
11. Hard-refresh the `/exec` URL.

Editing source files does not update an existing production deployment until a new version is deployed.

## Publishing the source on GitHub

### Beginner method using the GitHub website

1. Sign in to [GitHub](https://github.com).
2. Click **New repository**.
3. Enter a repository name, for example, `quanbian-company-approach-crm`.
4. Choose Public or Private.
5. Do not ask GitHub to create another README because this project already includes one.
6. Create the repository.
7. Click **Add file > Upload files**.
8. Upload the contents of the `quanbian-company-crm` folder, not the outer ZIP itself.
9. Confirm that `README.md`, `.gitignore`, all `.gs` and `.html` files, `appsscript.json`, documentation and tests are present.
10. Commit the files.

### Never upload these items

- the real `.clasp.json` file containing your Apps Script project ID;
- exported company databases or historical Excel records;
- contact lists, personal emails or phone numbers;
- downloaded Gmail data;
- copied Drive asset folders;
- OAuth tokens, cookies, passwords or API credentials;
- screenshots containing confidential company information.

The included `.gitignore` blocks the local `.clasp.json` file. `.clasp.json.example` is safe because it contains only a placeholder.

### Optional command-line method

```bash
git init
git add .
git commit -m "Initial release of QuanBian Company Approach CRM"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPOSITORY.git
git push -u origin main
```

Replace the example repository URL with your own. GitHub may ask you to authenticate through the browser or a personal access token.

## Local tests

The regression tests require Node.js but do not contact Gmail, Drive or the database.

macOS, Linux or Git Bash:

```bash
for test_file in tests/*.test.js; do node "$test_file" || exit 1; done
```

Windows PowerShell:

```powershell
Get-ChildItem tests\*.test.js | ForEach-Object { node $_.FullName }
```

The test suite checks matching, email HTML safety, reply classification, permissions, startup compilation, UI event handling and session behavior.

## Troubleshooting

| Problem | What to check |
|---|---|
| CRM remains on the loading screen | Confirm `Api.gs`, `Index.html` and `App.html` came from the same release, then deploy a new version |
| `Malformed HTML content` | Replace all project files and verify the Base64 application loader from the current release |
| `Invalid or unexpected token` | Replace `Api.gs`, `Index.html` and `App.html`, then deploy a new version |
| Gmail API is undefined | Add Gmail API v1 under Apps Script Services and confirm the manifest was replaced |
| Permission error | Run `authorizeSystem()` manually and approve every required scope |
| Scheduling does not run | Use Repair scheduler or run `createAutomationTriggers()` |
| Reply does not appear | Reply from another account, wait for Gmail indexing, then click Sync Gmail now |
| Image looks too small | Use a transparent PNG, re-upload it, select it in the editor and click Fit logo |
| Image row becomes joined text | Replace `App.html` from version 2.5.0 or later |
| `50,000 characters` error | Replace all current files so long HTML is stored in Drive instead of one Sheet cell |
| Changes do not appear | Deploy a New version and hard-refresh the `/exec` URL |

## Security and privacy

- Deploy as the owner and restrict access to **Only myself** for the shared-account model.
- The selected committee name is operational attribution, not strong authentication between members sharing one Google login.
- Do not use this CRM to store payment-card details, government identification numbers, health information or passwords.
- Review committee access whenever members leave the organization.
- Keep regular read-only backups of the spreadsheet.
- Treat company contact information and Gmail content as confidential organizational data.

## Starting a new committee batch

1. Make a read-only archive copy of the existing CRM Sheet.
2. Create a new blank Google Sheet.
3. Install the project using this guide.
4. Run `setupSystem()` and `authorizeSystem()`.
5. Add the new committee members.
6. Rebuild or publish the new campaign templates.
7. Keep the old Excel and CRM archive as manual historical references.

This preserves the clean-database teaching model while keeping prior records available for manual reference.

## Creator and attribution

Created by **Lim Huey Wen** for the 全辩 company outreach workflow.

The creator credit is included in the application metadata, member-selection screen, sidebar and this README. Preserve the credit when redistributing or adapting the project.

## License

No open-source license is included in this repository. Publishing the source on GitHub does not automatically grant permission for others to copy, modify or redistribute it. Add a license file only after the creator has chosen the intended reuse terms.

## Official references

- [Google Apps Script web-app deployment](https://developers.google.com/apps-script/guides/web)
- [Google Apps Script advanced services](https://developers.google.com/apps-script/guides/services/advanced)
- [Google Apps Script authorization](https://developers.google.com/apps-script/guides/services/authorization)
