function showFAQ() {
  const html = HtmlService.createHtmlOutputFromFile('FAQGuide')
    .setWidth(700)
    .setHeight(550);
  SpreadsheetApp.getUi().showModalDialog(html, "DQE Spreadsheet FAQ & Guide");
}
