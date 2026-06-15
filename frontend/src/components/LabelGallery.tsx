export function LabelGallery({
  images,
  previews,
  busy = false,
  onOpen,
}: {
  images: File[];
  previews: Record<string, string>;
  busy?: boolean;
  onOpen: (src: string) => void;
}) {
  return (
    <div className="gallery">
      {images.map((f) => (
        <figure key={f.name} className="gitem">
          <button
            type="button"
            className="gimg-btn"
            onClick={() => onOpen(previews[f.name])}
            aria-label={`View ${f.name} full size`}
          >
            <img className="gimg" src={previews[f.name]} alt={f.name} />
            {busy && (
              <div className="gprogress" role="progressbar" aria-label="Analyzing">
                <div className="gprogress-bar" />
              </div>
            )}
          </button>
          <figcaption className="gcap">{f.name}</figcaption>
        </figure>
      ))}
    </div>
  );
}
