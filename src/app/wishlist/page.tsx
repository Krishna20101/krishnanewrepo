"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Wishlist feature hata diya gaya hai (v4). Purane bookmark/link kaam karein
 * isliye page seedha home par redirect karta hai.
 */
export default function WishlistPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/");
  }, [router]);
  return null;
}
