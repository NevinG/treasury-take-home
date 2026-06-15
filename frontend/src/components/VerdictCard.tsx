import type { LabelVerdict } from "../types";
import { StatusChip } from "./StatusChip";

function Val({ value }: { value: string }) {
  return value ? <>{value}</> : <span className="empty-val">—</span>;
}

export function VerdictCard({ verdict }: { verdict: LabelVerdict }) {
  return (
    <div className="card">
      <div className="card-head">
        <span className="fname">Verification result</span>
        <span style={{ marginLeft: "auto" }}>
          <span className={`badge ${verdict.overall}`}>
            {verdict.overall === "pass"
              ? "PASS"
              : verdict.overall === "fail"
              ? "DOES NOT MATCH"
              : "NEEDS REVIEW"}
          </span>
        </span>
      </div>
      <div style={{ padding: "16px" }}>
        {!verdict.matchedApplication && (
          <div className="note" style={{ marginBottom: 10 }}>
            No application details were matched — compared against blanks.
          </div>
        )}
        <table className="vtable">
          <thead>
            <tr>
              <th>Mandatory element</th>
              <th>Application says</th>
              <th>On the label</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {verdict.fields.map((f) => (
              <tr key={f.key}>
                <td>{f.label}</td>
                <td className="val">
                  <Val value={f.expected} />
                </td>
                <td className="val">
                  <Val value={f.evidence} />
                </td>
                <td>
                  <StatusChip status={f.status} />
                  {f.status !== "match" && <div className="note">{f.note}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="warnblock">
          <div className="whead">
            <strong>Government warning</strong>
            <StatusChip status={verdict.warning.status} />
          </div>
          <div className="note">{verdict.warning.note}</div>
          {verdict.warning.extractedText && (
            <div className="warntext">{verdict.warning.extractedText}</div>
          )}
        </div>
      </div>
    </div>
  );
}
