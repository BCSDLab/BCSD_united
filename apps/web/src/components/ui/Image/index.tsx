import type { ComponentProps } from 'react';

const DEVICE_WIDTHS = [640, 750, 828, 1080, 1200, 1920, 2048, 3840];
const IMAGE_WIDTHS = [16, 32, 48, 64, 96, 128, 256, 384, ...DEVICE_WIDTHS];

interface ImageProps extends Omit<ComponentProps<'img'>, 'src' | 'srcSet'> {
  src: string;
  alt: string;
  fill?: boolean;
  priority?: boolean;
  quality?: number;
  unoptimized?: boolean;
}

function getImageUrl(src: string, width: number, quality: number) {
  return `/api/image?${new URLSearchParams({ url: src, w: String(width), q: String(quality) })}`;
}

function getWidths(width: ImageProps['width'], sizes: string | undefined) {
  if (sizes) {
    const viewportWidths = [...sizes.matchAll(/(^|\s)(1?\d?\d)vw/g)].map((match) => Number(match[2]));
    const minimumWidth = viewportWidths.length ? DEVICE_WIDTHS[0] * Math.min(...viewportWidths) / 100 : 0;
    return { widths: IMAGE_WIDTHS.filter((candidate) => candidate >= minimumWidth), descriptor: 'w' } as const;
  }

  const numericWidth = Number(width);
  if (!Number.isFinite(numericWidth) || numericWidth <= 0) {
    return { widths: DEVICE_WIDTHS, descriptor: 'w' } as const;
  }

  const widths = [...new Set([numericWidth, numericWidth * 2].map(
    (target) => IMAGE_WIDTHS.find((candidate) => candidate >= target) ?? IMAGE_WIDTHS[IMAGE_WIDTHS.length - 1],
  ))];
  return { widths, descriptor: 'x' } as const;
}

/** 업로드 미리보기와 SVG는 원본을 사용하고, 래스터 이미지는 이미지 API에서 크기를 조정한다. */
export default function Image({
  src,
  alt,
  width,
  height,
  fill = false,
  priority = false,
  quality = 75,
  unoptimized = false,
  sizes,
  loading,
  fetchPriority,
  decoding = 'async',
  style,
  ...props
}: ImageProps) {
  const useOriginal = unoptimized || /^(?:blob:|data:)/i.test(src) || /\.svg(?:[?#]|$)/i.test(src);
  const candidates = useOriginal ? null : getWidths(width, sizes);
  const resolvedSizes = sizes ?? (candidates?.descriptor === 'w' ? '100vw' : undefined);
  const srcSet = candidates?.widths.map((candidate, index) => (
    `${getImageUrl(src, candidate, quality)} ${candidates.descriptor === 'w' ? candidate : index + 1}${candidates.descriptor}`
  )).join(', ');
  const imageSrc = candidates
    ? getImageUrl(src, candidates.widths[candidates.widths.length - 1], quality)
    : src;

  return (
    <img
      {...props}
      alt={alt}
      width={fill ? undefined : width}
      height={fill ? undefined : height}
      loading={priority ? 'eager' : loading ?? 'lazy'}
      fetchPriority={priority ? 'high' : fetchPriority}
      decoding={decoding}
      style={fill ? { position: 'absolute', inset: 0, width: '100%', height: '100%', ...style } : style}
      sizes={resolvedSizes}
      srcSet={srcSet}
      src={imageSrc}
    />
  );
}
