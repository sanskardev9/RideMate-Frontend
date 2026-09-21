/** Full-screen loading state, used while the stored session is verified. */
export function Loader({ label = "Getting your crew together" }: { label?: string }) {
  return (
    <div className="loader-screen">
      <div className="loader" role="status" aria-live="polite">
        <div className="loader-ring">
          <span className="loader-mark">RM</span>
        </div>
        <p className="loader-text">
          {label}
          <span className="loader-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </p>
      </div>
    </div>
  );
}
