/**
 * A sheet still being plotted.
 *
 * Traversals on this graph run anywhere from 20ms to four seconds, and which
 * one you are waiting on is information — so the wait states the query being
 * run rather than showing an indeterminate spinner that could mean anything.
 * The bars are a sheet printing across, matching the row-entrance motion the
 * results themselves arrive with.
 */
export function Plotting({ label, rows = 3 }: { label: string; rows?: number }): JSX.Element {
  const widths = ['w-80', 'w-60', 'w-40', 'w-60', 'w-80'];
  return (
    <div className="plotting" role="status" aria-live="polite">
      <div className="plotting-label">{label}</div>
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className={`skeleton ${widths[index % widths.length]}`}
          style={{ animationDelay: `${index * 90}ms` }}
        />
      ))}
    </div>
  );
}
