"use client";

import React, { useEffect, useState } from "react";
import { SITE_CONFIG } from "@/config/siteConfig";

interface SafeImageProps
  extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src"> {
  src?: string | null;
  fallbackSrc?: string;
}

/**
 * Renders image safely; if JSON thumbnail URL is missing ("") or fails to load,
 * automatically switches to the configured Default Placeholder Image URL!
 */
export default function SafeImage({
  src,
  fallbackSrc,
  alt = "Study helper Doc",
  className = "",
  ...rest
}: SafeImageProps) {
  const effectiveFallback = fallbackSrc || SITE_CONFIG.defaultImageUrl;
  const cleanSrc = src && src.trim().length > 0 ? src.trim() : effectiveFallback;

  const [imgSrc, setImgSrc] = useState<string>(cleanSrc);

  useEffect(() => {
    setImgSrc(src && src.trim().length > 0 ? src.trim() : effectiveFallback);
  }, [src, effectiveFallback]);

  return (
    <img
      src={imgSrc}
      alt={alt}
      loading="lazy"
      onError={() => {
        if (imgSrc !== effectiveFallback) {
          setImgSrc(effectiveFallback);
        }
      }}
      className={className}
      {...rest}
    />
  );
}
