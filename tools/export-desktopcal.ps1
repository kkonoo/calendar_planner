# Export DesktopCal data to JSON so the planner can import it (Settings > Import).
# Reads a temporary copy of the database; the original is never modified.
param(
  [string]$DbPath = "$env:APPDATA\CalendarTask\Db\calendar.db",
  [string]$OutPath = (Join-Path $PSScriptRoot '..\data\desktopcal-export.json')
)
$ErrorActionPreference = 'Stop'

Add-Type -ReferencedAssemblies System.Web.Extensions -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

public static class DcExport {
  // winsqlite3.dll ships with Windows 10/11
  [DllImport("winsqlite3.dll")] static extern int sqlite3_open_v2(byte[] file, out IntPtr db, int flags, IntPtr vfs);
  [DllImport("winsqlite3.dll")] static extern int sqlite3_prepare_v2(IntPtr db, byte[] sql, int n, out IntPtr st, IntPtr tail);
  [DllImport("winsqlite3.dll")] static extern int sqlite3_step(IntPtr st);
  [DllImport("winsqlite3.dll")] static extern int sqlite3_column_count(IntPtr st);
  [DllImport("winsqlite3.dll")] static extern IntPtr sqlite3_column_name(IntPtr st, int i);
  [DllImport("winsqlite3.dll")] static extern IntPtr sqlite3_column_text(IntPtr st, int i);
  [DllImport("winsqlite3.dll")] static extern int sqlite3_column_bytes(IntPtr st, int i);
  [DllImport("winsqlite3.dll")] static extern int sqlite3_finalize(IntPtr st);
  [DllImport("winsqlite3.dll")] static extern int sqlite3_close(IntPtr db);

  static byte[] Utf8z(string s) { return Encoding.UTF8.GetBytes(s + "\0"); }

  static List<Dictionary<string, string>> Query(IntPtr db, string sql) {
    IntPtr st;
    if (sqlite3_prepare_v2(db, Utf8z(sql), -1, out st, IntPtr.Zero) != 0) throw new Exception("Query failed: " + sql);
    var rows = new List<Dictionary<string, string>>();
    int n = sqlite3_column_count(st);
    while (sqlite3_step(st) == 100) {
      var row = new Dictionary<string, string>();
      for (int i = 0; i < n; i++) {
        IntPtr p = sqlite3_column_text(st, i);
        var buf = new byte[sqlite3_column_bytes(st, i)];
        if (p != IntPtr.Zero) Marshal.Copy(p, buf, 0, buf.Length);
        row[Marshal.PtrToStringAnsi(sqlite3_column_name(st, i))] = Encoding.UTF8.GetString(buf);
      }
      rows.Add(row);
    }
    sqlite3_finalize(st);
    return rows;
  }

  public static string Export(string path) {
    IntPtr db;
    if (sqlite3_open_v2(Utf8z(path), out db, 1, IntPtr.Zero) != 0) throw new Exception("Cannot open " + path);
    try {
      var data = new Dictionary<string, object>();
      data["source"] = "desktopcal";
      data["exportedAt"] = DateTime.Now.ToString("s");
      data["items"] = Query(db, "SELECT it_unique_id AS unique_id, it_content AS content FROM item_table WHERE it_content <> ''");
      data["events"] = Query(db, "SELECT ev_unique_id AS unique_id, ev_content AS content, ev_status AS status, ev_start_date AS start, ev_recurrence AS rrule, ev_info AS info FROM event_table");
      var json = new JavaScriptSerializer();
      json.MaxJsonLength = int.MaxValue;
      return json.Serialize(data);
    } finally {
      sqlite3_close(db);
    }
  }
}
'@

$tmp = Join-Path $env:TEMP 'desktopcal-export-copy.db'
Copy-Item -LiteralPath $DbPath -Destination $tmp -Force
try {
  $json = [DcExport]::Export($tmp)
} finally {
  Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue
}

$out = [IO.Path]::GetFullPath($OutPath)
New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
[IO.File]::WriteAllText($out, $json, (New-Object Text.UTF8Encoding $false))
Write-Host "Saved: $out"
