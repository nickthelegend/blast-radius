/**
 * Survey conditions — the provenance strip in a sheet's bottom margin.
 *
 * A survey chart records the conditions it was taken under, and so does every
 * sheet here: how long the traversal ran, which procedure produced it, which
 * consistency mode it read at, and which epoch it pinned. The product's first
 * principle is that any number it states must be traceable, and hiding the
 * read epoch behind an ellipsis would break that for the sake of tidiness.
 */
export function Conditions({
  entries,
}: {
  entries: Array<[label: string, value: string | number | null | undefined]>;
}): JSX.Element {
  return (
    <dl className="conditions">
      {entries
        .filter(([, value]) => value !== null && value !== undefined && value !== '')
        .map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}
