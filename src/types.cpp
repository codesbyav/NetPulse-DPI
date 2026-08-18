#include "types.h"
#include <sstream>
#include <iomanip>
#include <algorithm>
#include <cctype>

namespace DPI {

std::string FiveTuple::toString() const {
    std::ostringstream ss;
    auto formatIP = [](uint32_t ip) {
        std::ostringstream s;
        s << ((ip >> 0) & 0xFF) << "."
          << ((ip >> 8) & 0xFF) << "."
          << ((ip >> 16) & 0xFF) << "."
          << ((ip >> 24) & 0xFF);
        return s.str();
    };
    ss << formatIP(src_ip) << ":" << src_port
       << " -> " << formatIP(dst_ip) << ":" << dst_port
       << " (" << (protocol == 6 ? "TCP" : protocol == 17 ? "UDP" : "?") << ")";
    return ss.str();
}

std::string appTypeToString(AppType type) {
    switch (type) {
        case AppType::UNKNOWN:    return "Unknown";
        case AppType::HTTP:       return "HTTP";
        case AppType::HTTPS:      return "HTTPS";
        case AppType::DNS:        return "DNS";
        case AppType::TLS:        return "TLS";
        case AppType::QUIC:       return "QUIC";
        case AppType::GOOGLE:     return "Google";
        case AppType::FACEBOOK:   return "Facebook";
        case AppType::YOUTUBE:    return "YouTube";
        case AppType::TWITTER:    return "Twitter/X";
        case AppType::INSTAGRAM:  return "Instagram";
        case AppType::NETFLIX:    return "Netflix";
        case AppType::AMAZON:     return "Amazon";
        case AppType::MICROSOFT:  return "Microsoft";
        case AppType::APPLE:      return "Apple";
        case AppType::WHATSAPP:   return "WhatsApp";
        case AppType::TELEGRAM:   return "Telegram";
        case AppType::TIKTOK:     return "TikTok";
        case AppType::SPOTIFY:    return "Spotify";
        case AppType::ZOOM:       return "Zoom";
        case AppType::DISCORD:    return "Discord";
        case AppType::GITHUB:     return "GitHub";
        case AppType::CLOUDFLARE: return "Cloudflare";
        default:                  return "Unknown";
    }
}

AppType sniToAppType(const std::string& sni) {
    if (sni.empty()) return AppType::UNKNOWN;

    std::string host = sni;
    std::transform(host.begin(), host.end(), host.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });

    // Match host/domain labels rather than arbitrary substrings. This prevents
    // collisions such as "netflix.com" matching Twitter because "netflix.com"
    // contains the substring "x.com".
    auto hasToken = [&host](const std::string& token) {
        if (host == token) return true;
        if (host.size() > token.size() &&
            host.compare(host.size() - token.size(), token.size(), token) == 0 &&
            host[host.size() - token.size() - 1] == '.') return true;
        return host.find("." + token + ".") != std::string::npos;
    };

    auto hasSubstring = [&host](const std::string& token) {
        return host.find(token) != std::string::npos;
    };

    // Specific applications first; broad provider patterns come later.
    if (hasToken("youtube.com") || hasToken("youtube-nocookie.com") ||
        hasToken("youtu.be") || hasSubstring("ytimg") || hasSubstring("yt3.ggpht")) {
        return AppType::YOUTUBE;
    }

    if (hasToken("facebook.com") || hasToken("fb.com") ||
        hasSubstring("fbcdn") || hasSubstring("fbsbx") || hasToken("meta.com")) {
        return AppType::FACEBOOK;
    }

    if (hasToken("instagram.com") || hasSubstring("cdninstagram")) {
        return AppType::INSTAGRAM;
    }

    if (hasToken("whatsapp.com") || hasToken("whatsapp.net") || hasToken("wa.me")) {
        return AppType::WHATSAPP;
    }

    if (hasToken("twitter.com") || hasToken("x.com") || hasToken("t.co") ||
        hasSubstring("twimg")) {
        return AppType::TWITTER;
    }

    if (hasToken("netflix.com") || hasSubstring("nflxvideo") || hasSubstring("nflximg")) {
        return AppType::NETFLIX;
    }

    if (hasToken("amazon.com") || hasToken("amazonaws.com") ||
        hasSubstring("cloudfront") || hasSubstring("amazonaws")) {
        return AppType::AMAZON;
    }

    if (hasToken("microsoft.com") || hasToken("msn.com") || hasSubstring("office") ||
        hasSubstring("azure") || hasToken("live.com") || hasSubstring("outlook") ||
        hasToken("bing.com")) {
        return AppType::MICROSOFT;
    }

    if (hasToken("apple.com") || hasToken("icloud.com") || hasSubstring("mzstatic") ||
        hasSubstring("itunes")) {
        return AppType::APPLE;
    }

    if (hasToken("telegram.org") || hasToken("t.me") || hasSubstring("telegram")) {
        return AppType::TELEGRAM;
    }

    if (hasToken("tiktok.com") || hasSubstring("tiktokcdn") ||
        hasToken("musical.ly") || hasSubstring("bytedance")) {
        return AppType::TIKTOK;
    }

    if (hasToken("spotify.com") || hasSubstring("scdn.co")) {
        return AppType::SPOTIFY;
    }

    if (hasToken("zoom.us") || hasSubstring("zoom")) {
        return AppType::ZOOM;
    }

    if (hasToken("discord.com") || hasSubstring("discordapp")) {
        return AppType::DISCORD;
    }

    if (hasToken("github.com") || hasSubstring("githubusercontent")) {
        return AppType::GITHUB;
    }

    if (hasToken("cloudflare.com") || hasSubstring("cloudflare")) {
        return AppType::CLOUDFLARE;
    }

    // Google provider patterns are intentionally after the app-specific rules.
    if (hasToken("google.com") || hasSubstring("gstatic") ||
        hasSubstring("googleapis") || hasSubstring("ggpht") || hasSubstring("gvt1")) {
        return AppType::GOOGLE;
    }

    return AppType::HTTPS;
}

} // namespace DPI
