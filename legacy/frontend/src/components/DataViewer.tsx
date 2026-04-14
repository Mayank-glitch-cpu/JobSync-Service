import { useEffect, useState } from 'react';
import { useApi } from '../hooks/useApi';

interface DataViewerProps {
  step: number;
  refreshKey: number;
}

// Column configs per step
const STEP_COLUMNS: Record<number, { key: string; label: string; width?: string }[]> = {
  1: [
    { key: 'company', label: 'Company', width: '140px' },
    { key: 'positionTitle', label: 'Position', width: '200px' },
    { key: 'location', label: 'Location', width: '140px' },
    { key: 'datePosted', label: 'Date', width: '100px' },
    { key: 'applyLink', label: 'Link', width: '60px' },
  ],
  2: [
    { key: 'company', label: 'Company', width: '120px' },
    { key: 'positionTitle', label: 'Position', width: '180px' },
    { key: 'scrapeStatus', label: 'Scrape', width: '80px' },
    { key: 'jdPreview', label: 'JD Preview', width: '250px' },
  ],
  3: [
    { key: 'company', label: 'Company', width: '120px' },
    { key: 'positionTitle', label: 'Position', width: '160px' },
    { key: 'industry', label: 'Industry', width: '130px' },
    { key: 'workModel', label: 'Model', width: '80px' },
    { key: 'h1bSponsored', label: 'H1B', width: '50px' },
    { key: 'aiConfidence', label: 'Conf', width: '50px' },
  ],
  4: [
    { key: 'company', label: 'Company', width: '120px' },
    { key: 'positionTitle', label: 'Position', width: '160px' },
    { key: 'syncedToAirtable', label: 'Synced', width: '70px' },
    { key: 'airtableRecordId', label: 'Record ID', width: '160px' },
    { key: 'syncError', label: 'Error', width: '200px' },
  ],
};

function getCellValue(row: Record<string, unknown>, key: string): string {
  if (key === 'applyLink') {
    const val = row[key] as string | null;
    return val ? 'Link' : '-';
  }
  if (key === 'jdPreview') {
    const jd = row['jobDescription'] as string | null;
    return jd ? jd.slice(0, 100) + '...' : '-';
  }
  if (key === 'h1bSponsored') {
    const val = row[key];
    return val === true ? 'Yes' : val === false ? 'No' : '-';
  }
  if (key === 'syncedToAirtable') {
    return row[key] ? 'Yes' : 'No';
  }
  if (key === 'aiConfidence') {
    const val = row[key] as number | null;
    return val !== null && val !== undefined ? `${(val * 100).toFixed(0)}%` : '-';
  }
  const val = row[key];
  if (val === null || val === undefined) return '-';
  return String(val);
}

export function DataViewer({ step, refreshKey }: DataViewerProps) {
  const { getStepData } = useApi();
  const [data, setData] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(false);
  const [viewJson, setViewJson] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getStepData(step)
      .then((res) => {
        if (!cancelled) {
          setData((res.jobs || []) as Record<string, unknown>[]);
        }
      })
      .catch(() => {
        if (!cancelled) setData([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [step, refreshKey, getStepData]);

  const columns = STEP_COLUMNS[step] || STEP_COLUMNS[1];

  return (
    <div className="data-viewer">
      <div className="data-viewer-header">
        <h3>Step {step} Data ({data.length} jobs)</h3>
        <button
          className="json-toggle-btn"
          onClick={() => setViewJson(!viewJson)}
        >
          {viewJson ? 'Table View' : 'JSON View'}
        </button>
      </div>
      {loading ? (
        <div className="data-loading">Loading...</div>
      ) : data.length === 0 ? (
        <div className="data-empty">No data. Run step {step} first.</div>
      ) : viewJson ? (
        <pre className="data-json">{JSON.stringify(data, null, 2)}</pre>
      ) : (
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                {columns.map((col) => (
                  <th key={col.key} style={{ width: col.width }}>
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((row, i) => (
                <tr key={i}>
                  {columns.map((col) => (
                    <td key={col.key} title={getCellValue(row, col.key)}>
                      {col.key === 'applyLink' && row[col.key] ? (
                        <a
                          href={row[col.key] as string}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Open
                        </a>
                      ) : (
                        getCellValue(row, col.key)
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
