import { DEFAULT_TRACK_FILTERS } from "../data/trackOrdering";

export default function TrackFilterControls({ id, filters, onChange, shownCount, totalCount, onEscape }) {
  return (
    <div className="track-filters" id={id} onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onEscape?.();
      }
    }}>
      <p>Choose track types and test status. A test track can also be dynamic or simple.</p>
      <div className="track-filters__groups">
        <fieldset>
          <legend>Track type</legend>
          {[["dynamic", "Dynamic"], ["simple", "Simple"]].map(([key, label]) => (
            <label key={key}>
              <input type="checkbox" checked={filters[key]} onChange={event => onChange({ ...filters, [key]: event.target.checked })} />
              {label}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Test tracks</legend>
          {[["all", "Include"], ["exclude", "Exclude"], ["only", "Only test tracks"]].map(([value, label]) => (
            <label key={value}>
              <input type="radio" name={`${id}-test-status`} value={value} checked={filters.tests === value} onChange={() => onChange({ ...filters, tests: value })} />
              {label}
            </label>
          ))}
        </fieldset>
      </div>
      <div className="track-filters__footer">
        <span role="status">{shownCount} of {totalCount} tracks shown</span>
        <button type="button" className="database-button database-button--quiet" onClick={() => onChange({ ...DEFAULT_TRACK_FILTERS })}>Show all tracks</button>
      </div>
    </div>
  );
}
