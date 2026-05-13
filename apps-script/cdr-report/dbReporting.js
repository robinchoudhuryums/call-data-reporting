function pullReportData(startDate, endDate, department) {
  const conn = getNeonConn();
  const stmt = conn.prepareStatement(`
    SELECT
      call_date,
      agent_name,
      ob_total, ob_answered, ob_missed,
      ib_total, ib_answered, ib_missed,
      ob_ext_total, ob_ext_answered,
      ob_ext_ttt_sec, ob_ext_att_sec
    FROM call_history_dept
    WHERE call_date BETWEEN ? AND ?
      AND (? IS NULL OR department = ?)
    ORDER BY call_date, agent_name
  `);

  stmt.setString(1, startDate);   // "YYYY-MM-DD"
  stmt.setString(2, endDate);
  stmt.setString(3, department);
  stmt.setString(4, department);

  const rs      = stmt.executeQuery();
  const meta    = rs.getMetaData();
  const numCols = meta.getColumnCount();
  const output  = [];

  // Header row
  const headers = [];
  for (let c = 1; c <= numCols; c++) headers.push(meta.getColumnName(c));
  output.push(headers);

  // Data rows
  while (rs.next()) {
    const row = [];
    for (let c = 1; c <= numCols; c++) row.push(rs.getString(c));
    output.push(row);
  }

  rs.close();
  conn.close();

  // Write to a sheet named "Report Output"
  const sheet = SpreadsheetApp.getActiveSpreadsheet()
                  .getSheetByName('Report Output');
  sheet.clearContents();
  sheet.getRange(1, 1, output.length, output[0].length).setValues(output);
  Logger.log(`Report pulled: ${output.length - 1} rows.`);
}