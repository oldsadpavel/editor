import logoSvg from '../assets/mpi-logo.svg?raw';

/** The MPI logo (the same SVG the app icon is built from). `animated`: data runs along the wires, LEDs blink. */
export function Logo({ size, animated, className }: { size: number; animated?: boolean; className?: string }) {
  return (
    <span
      className={`logo-svg ${animated ? 'logo-live' : ''} ${className ?? ''}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: logoSvg }}
    />
  );
}
