import Link from "next/link";
import { frontdeskSidebarLinks } from "../lib/frontdeskNav";

export default function FrontdeskNavigation({ activePath }) {
  return (
    <nav className="frontdesk-workspace-nav" aria-label="Frontdesk navigation">
      {frontdeskSidebarLinks(activePath).map((link) => (
        <Link key={link.href} href={link.href} aria-current={link.active ? "page" : undefined}>
          <i className={link.icon} aria-hidden="true" />
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
