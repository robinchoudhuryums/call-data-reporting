function autoDropdown(e) {
  const sheet = e ? e.range.getSheet() : SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  SpreadsheetApp.flush();

  // Look for "Agent Name" in headers on row 4 (W4:AD4)
  const headerRow = sheet.getRange("W4:AD4").getValues()[0];
  let agentColIndex = null;

  for (let i = 0; i < headerRow.length; i++) {
    if (headerRow[i] === "Agent Select") {
      agentColIndex = i + 23; // W=23, then offset by i
      break;
    }
  }

  if (!agentColIndex) {
   // SpreadsheetApp.getUi().alert('Could not find "Agent Select" header in row 4.');
    return;
  }

  // Place dropdown under it in row 5
  const dropdownCell = sheet.getRange(5, agentColIndex);

  // Build list from dataset in table under row 7 (agent names start in W8:W20)
  const dataStartRow = 8; // row 8 is first data row
  const numDataRows = 13; // covers W8:W20
  const nameRange = sheet.getRange(dataStartRow, agentColIndex, numDataRows, 1);
  const names = nameRange.getValues().flat().filter(name => name !== "" && name != null);

  if (names.length > 0) {
    const rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(names, true)
      .setAllowInvalid(false)
      .build();
    dropdownCell.setDataValidation(rule);
    dropdownCell.setValue(names[0]); // prefill with first employee
  } else {
    dropdownCell.clearDataValidations();
    dropdownCell.clearContent();
  }
}

function onEdit(e) {
  const editedCell = e.range.getA1Notation();
  if (editedCell === "X2" || editedCell === "Z2") {
    autoDropdown();
  }
}

