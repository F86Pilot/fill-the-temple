// Fill the Temple: nightly backup of every submission to Google Drive.
//
// Setup (once):
//   1. Go to https://script.google.com, click "New project", delete what's there, and paste this whole file.
//   2. Put your site's address in SITE and your admin password in ADMIN_KEY below, and click Save (the disk icon).
//   3. Pick "setup" in the function menu at the top and click Run. Allow access when Google asks.
//      Google will warn the app isn't verified; it's your own script, so click Advanced, then "Go to ...".
//
// It saves a backup right away, then every evening around 9pm if anything changed, into a Drive folder
// called "Fill the Temple backups". If a backup ever fails (say, after you change the admin password),
// Google emails you about it. Run "setup" again after changing anything below.

const SITE = 'https://fill-the-temple.YOUR-SUBDOMAIN.workers.dev';   // your site's address (npm run deploy prints it)
const ADMIN_KEY = 'paste-your-admin-password-here';
const FOLDER_NAME = 'Fill the Temple backups';

function setup() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('backup').timeBased().everyDays(1).atHour(21).create();
  backup(true);
}

function backup(force) {
  const res = UrlFetchApp.fetch(SITE + '/api/admin/export.csv', {
    headers: { Authorization: 'Bearer ' + ADMIN_KEY },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() === 401) throw new Error('Wrong admin password. Update ADMIN_KEY in this script.');
  if (res.getResponseCode() !== 200) throw new Error('Backup failed: the site answered ' + res.getResponseCode());

  const csv = res.getContentText();
  const props = PropertiesService.getScriptProperties();
  const hash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, csv));
  if (force !== true && props.getProperty('lastHash') === hash) return;   // nothing changed since the last backup

  const folders = DriveApp.getFoldersByName(FOLDER_NAME);
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(FOLDER_NAME);
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HHmm');
  folder.createFile('temple-submissions ' + stamp + '.csv', csv, MimeType.CSV);
  props.setProperty('lastHash', hash);
}
