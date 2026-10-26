#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
===============================================================================
  STUDY HELPER DOC — TELEGRAM SESSION STRING + GROUP ID GENERATOR (session.py)
===============================================================================
  Kahan chala sakte hain?
  - Android Phone: Termux ya Pydroid 3 app me
  - Laptop / PC: Windows / Mac / Linux terminal me
  - Browser (Bina kuch install kiye): Google Colab (https://colab.research.google.com)

  Kaise chalayein?
    python session.py
===============================================================================
"""

import asyncio
import base64
import struct
import subprocess
import sys

# Step 1: Agar 'telethon' install nahi hai to apne aap install kar lega
try:
    from telethon import TelegramClient
    from telethon.errors import (
        PhoneCodeExpiredError,
        PhoneCodeInvalidError,
        PasswordHashInvalidError,
        SessionPasswordNeededError,
    )
    from telethon.sessions import MemorySession
except ImportError:
    print("\n[*] Installing 'telethon' library... Please wait 5-10 seconds...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "telethon"])
    from telethon import TelegramClient
    from telethon.errors import (
        PhoneCodeExpiredError,
        PhoneCodeInvalidError,
        PasswordHashInvalidError,
        SessionPasswordNeededError,
    )
    from telethon.sessions import MemorySession


# Official Telegram Production IPv4 Data Centers (100% Vercel & Server Compatible)
TELEGRAM_DC_IPV4 = {
    1: "149.154.175.53",
    2: "149.154.167.51",
    3: "149.154.175.100",
    4: "149.154.167.91",
    5: "91.108.56.130",
}


def build_website_session_string(
    dc_id: int, server_address: str, port: int, auth_key_bytes: bytes
) -> str:
    """
    Packs the exact GramJS / Website-compatible StringSession ('1' + standard Base64)
    using IPv4 DC addresses so Vercel Serverless connects in <200ms every time.
    """
    clean_ip = server_address or TELEGRAM_DC_IPV4.get(dc_id, "149.154.167.91")
    if ":" in clean_ip and dc_id in TELEGRAM_DC_IPV4:
        # Convert any mobile IPv6 DC address to official IPv4 for Vercel compatibility
        clean_ip = TELEGRAM_DC_IPV4[dc_id]

    clean_port = int(port or 443)
    addr_bytes = clean_ip.encode("utf-8")

    payload = (
        struct.pack(">B", int(dc_id))
        + struct.pack(">h", len(addr_bytes))
        + addr_bytes
        + struct.pack(">h", clean_port)
        + auth_key_bytes
    )
    return "1" + base64.b64encode(payload).decode("ascii")


async def generate_session() -> None:
    print("\n" + "=" * 68)
    print("   STUDY HELPER DOC — TELEGRAM SESSION & GROUP ID GENERATOR")
    print("=" * 68)
    print("  1. API ID aur API Hash yahan se milega: https://my.telegram.org")
    print("     (Login -> 'API development tools' -> Copy App api_id & api_hash)")
    print("=" * 68 + "\n")

    # 1. Input API ID & API Hash
    while True:
        raw_api_id = input("👉 Enter Telegram API ID (numbers only): ").strip()
        if raw_api_id.isdigit():
            api_id = int(raw_api_id)
            break
        print("❌ Galat API ID! Sirf numbers daalein (jaise 24819201).")

    while True:
        api_hash = input("👉 Enter Telegram API Hash (32-char string): ").strip()
        if len(api_hash) >= 16:
            break
        print("❌ API Hash sahi se paste karein!")

    phone = input(
        "\n👉 Enter Phone Number with Country Code (e.g. +919876543210): "
    ).strip()
    if phone and not phone.startswith("+"):
        phone = "+" + phone

    print("\n⏳ Please wait, connecting to Telegram servers...")

    # Force IPv4 & MemorySession (zero local .session file left behind!)
    client = TelegramClient(MemorySession(), api_id, api_hash, use_ipv6=False)
    await client.connect()

    try:
        if not await client.is_user_authorized():
            sent = await client.send_code_request(phone)
            print(
                "\n📩 OTP aapke Telegram App me bhej diya gaya hai! (SMS nahi, Telegram chat check karein)"
            )

            while True:
                code = (
                    input("👉 Enter Telegram OTP Code: ")
                    .strip()
                    .replace(" ", "")
                    .replace("-", "")
                )
                try:
                    await client.sign_in(
                        phone=phone, code=code, phone_code_hash=sent.phone_code_hash
                    )
                    break
                except PhoneCodeInvalidError:
                    print("❌ Galat OTP! Dobara dhyan se daalein.")
                except PhoneCodeExpiredError:
                    print("⚠️ OTP expire ho gaya, naya OTP bhej rahe hain...")
                    sent = await client.send_code_request(phone)
                except SessionPasswordNeededError:
                    print(
                        "\n🔐 Aapke account par Two-Step Verification (2FA Password) laga hai."
                    )
                    while True:
                        pwd = input("👉 Enter your Telegram 2FA Password: ").strip()
                        try:
                            await client.sign_in(password=pwd)
                            break
                        except PasswordHashInvalidError:
                            print("❌ Galat 2FA Password! Dobara try karein.")
                    break

        me = await client.get_me()
        auth_key = client.session.auth_key
        if not auth_key or not auth_key.key:
            raise RuntimeError("Auth key generate nahi ho paya. Dobara run karein.")

        website_session_str = build_website_session_string(
            dc_id=client.session.dc_id,
            server_address=client.session.server_address,
            port=client.session.port,
            auth_key_bytes=auth_key.key,
        )

        user_name = f"{me.first_name or ''} {me.last_name or ''}".strip()
        print("\n" + "=" * 68)
        print(f"✅ LOGIN SUCCESSFUL! Account: {user_name} (ID: {me.id})")
        print("=" * 68)
        print("\n👇 NICHE WALA PURA SESSION STRING COPY KAREIN (1... se end tak):\n")
        print(website_session_str)
        print("\n" + "=" * 68)

        # Save a copy in Telegram "Saved Messages" for easy copy-paste on phone!
        save_choice = (
            input(
                "\n💾 Kya is Session String ko aapke Telegram 'Saved Messages' me bhej dein taaki copy karna aasan ho? (y/n) [y]: "
            )
            .strip()
            .lower()
        )
        if save_choice in ("", "y", "yes"):
            msg_text = (
                "🔐 **Study helper Doc — Website Session String**\n"
                "⚠️ *Ise kisi ke saath share mat karein!*\n\n"
                f"**API ID:** `{api_id}`\n"
                f"**API Hash:** `{api_hash}`\n\n"
                "**Session String (Tap to Copy):**\n"
                f"`{website_session_str}`"
            )
            await client.send_message("me", msg_text)
            print("✅ Aapke Telegram 'Saved Messages' me bhej diya gaya hai!")

        # Bonus Helper: List Private/Public Groups & Channels with exact -100... Chat ID!
        list_groups = (
            input(
                "\n📂 Kya aap apne joined Groups/Channels ka '-100...' Chat ID bhi dekhna chahte hain? (y/n) [y]: "
            )
            .strip()
            .lower()
        )
        if list_groups in ("", "y", "yes"):
            print("\n⏳ Aapke Groups aur Channels scan ho rahe hain...\n")
            print(f"{'CHAT ID (Copy This)':<22} | {'GROUP / CHANNEL NAME'}")
            print("-" * 68)
            count = 0
            async for dialog in client.iter_dialogs(limit=100):
                if dialog.is_group or dialog.is_channel:
                    print(f"{str(dialog.id):<22} | {dialog.name}")
                    count += 1
            if count == 0:
                print("Koi Group/Channel nahi mila.")
            print("-" * 68)
            print(
                "💡 Tip: Upar se kisi bhi Group ka '-100...' ID copy karke seedha\n"
                "   Website ke '/admin -> Telegram Sync Studio' me paste kar sakte hain!"
            )

        print("\n🎉 Done! Ab aap ise band kar sakte hain.\n")

    finally:
        await client.disconnect()


if __name__ == "__main__":
    try:
        asyncio.run(generate_session())
    except KeyboardInterrupt:
        print("\n\nCancelled by user.")
