export interface TableRow {
  [key: string]: string | number | boolean | null | undefined;
}

export function printJson(write: (line: string) => void, value: unknown): void {
  write(JSON.stringify(value, null, 2));
}

export function printSection(
  write: (line: string) => void,
  title: string,
  entries: Array<[string, string | number | boolean | null | undefined]>,
): void {
  write(title);
  const width = Math.max(...entries.map(([label]) => label.length), 0);

  for (const [label, value] of entries) {
    write(`  ${label.padEnd(width)} : ${formatScalar(value)}`);
  }
}

export function printTable(
  write: (line: string) => void,
  rows: TableRow[],
): void {
  if (rows.length === 0) {
    write("(none)");
    return;
  }

  const headers = Object.keys(rows[0] ?? {});
  const widths = headers.map((header) =>
    Math.max(
      header.length,
      ...rows.map((row) => formatScalar(row[header]).length),
    ),
  );

  write(
    headers
      .map((header, index) => header.padEnd(widths[index] ?? 0))
      .join("  "),
  );
  write(widths.map((width) => "-".repeat(width)).join("  "));

  for (const row of rows) {
    write(
      headers
        .map((header, index) =>
          formatScalar(row[header]).padEnd(widths[index] ?? 0),
        )
        .join("  "),
    );
  }
}

export function formatScalar(
  value: string | number | boolean | null | undefined,
): string {
  if (value == null) {
    return "-";
  }

  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }

  return String(value);
}
