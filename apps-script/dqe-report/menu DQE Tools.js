function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('DQE Tools')
    .addSubMenu(SpreadsheetApp.getUi().createMenu('Set Dates')
      .addItem('Last 30 Days', 'setLast30Days')
      .addItem('Last 60 Days', 'setLast60Days')
      .addItem('Last 90 Days', 'setLast90Days')
      .addItem('All Time', 'setAllTime'))
    .addItem('Force Low Ans % Alert', 'sendManualAlert_Restricted')
    .addItem('Single Range Report', 'openSingleRangeTool')
    .addItem('Comparison Range Report', 'multiComparisonTool_showForm_Restricted')
    .addItem('Individual Report', 'openIndividualReportTool')
    .addItem('Missed Call Times Report', 'openMissedReportTool')
    .addSeparator()
    .addItem('DQE Guide/FAQ', 'showFAQ')
    .addItem('Refresh dashboard', 'refreshDashboard')
    .addToUi();

  // On open, set B1 to most recent date and refresh
  try {
    setB1ToMostRecentDate();
    refreshDashboard();
  } catch (e) {
    Logger.log('onOpen refresh skipped: ' + e.message);
  }
}

// ... (Other functions like compareEmployeeDataBetweenRanges_showForm can stay as they are) ...

/* * FIX: Updated dimensions to match the new Multi-Comp Modal 
 */
function multiComparisonTool_showForm() {
  const html = HtmlService.createHtmlOutputFromFile('MultiCompModal')
    .setWidth(1400)  // CHANGED FROM 550
    .setHeight(1000); // CHANGED FROM 350
  SpreadsheetApp.getUi().showModalDialog(html, 'Date Range Comparison Tool');
}


function sendManualAlert_Restricted() {
  const allowedUsers = ['robin.choudhury@universalmedsupply.com'];
  const currentUser = Session.getActiveUser().getEmail();

  if (!allowedUsers.includes(currentUser)) {
    SpreadsheetApp.getUi().alert(`Sorry, you (${currentUser || 'unknown user'}) are not authorized to run this tool.`);

    MailApp.sendEmail({
      to: 'robin.choudhury@universalmedsupply.com',
      subject: 'Unauthorized attempt to Force Low Ans % Alert',
      body: `User ${currentUser || 'unknown'} attempted to run the Force Low Ans % Alert tool on ${new Date()}`
    });

    return;
  }

  sendManualAlert();
}

function multiComparisonTool_showForm_Restricted() {
  const allowedUsers = ['robin.choudhury@universalmedsupply.com'];
  const currentUser = Session.getActiveUser().getEmail();

  if (!allowedUsers.includes(currentUser)) {
    SpreadsheetApp.getUi().alert(`Sorry, you (${currentUser || 'unknown user'}) are not authorized to run this tool.`);

    MailApp.sendEmail({
      to: 'robin.choudhury@universalmedsupply.com',
      subject: 'Unauthorized attempt Multi-Comp Tool',
      body: `User ${currentUser || 'unknown'} attempted to run the Multi-Comp tool on ${new Date()}`
    });

    return;
  }

  // Call the updated function with larger dimensions
  multiComparisonTool_showForm();
}