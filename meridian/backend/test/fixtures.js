/**
 * Fixtures — handwritten, not captured from live feeds.
 *
 * Deliberate: a fixture recorded from a real outlet would embed that outlet's
 * article text in the repo, which the storage convention in CLAUDE.md rules
 * out. These reproduce the SHAPES that break parsers (CDATA, namespaced dates,
 * Atom link arrays, HTML in descriptions) with invented content.
 */

export const RSS_2_0 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Northwind Wire</title>
    <item>
      <title><![CDATA[Harbour authority raises dock fees by 12% after budget vote]]></title>
      <link>https://northwind.example/news/dock-fees?utm_source=rss</link>
      <pubDate>Wed, 16 Sep 2026 08:15:00 GMT</pubDate>
      <description><![CDATA[<p>The <b>harbour authority</b> approved the increase on Tuesday.&nbsp;Operators said the change lands mid-season.</p>]]></description>
    </item>
    <item>
      <title>Ferry operators warn of route cuts</title>
      <link>https://northwind.example/news/ferry-cuts</link>
      <dc:date>2026-09-16T11:00:00Z</dc:date>
      <description>Two operators said routes may be dropped &amp; schedules thinned.</description>
    </item>
    <item>
      <title>No link here</title>
      <description>Should be dropped for having no url.</description>
    </item>
  </channel>
</rss>`;

export const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Southport Register</title>
  <entry>
    <title>Dock fee rise of 12 percent confirmed by harbour authority</title>
    <link rel="replies" href="https://southport.example/comments/1"/>
    <link rel="alternate" href="https://southport.example/2026/09/dock-fee-rise"/>
    <updated>2026-09-16T09:40:00Z</updated>
    <summary type="html">&lt;p&gt;The authority confirmed the rise after a split vote.&lt;/p&gt;</summary>
  </entry>
</feed>`;

export const LONG_DESCRIPTION_RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><item>
  <title>Long one</title>
  <link>https://long.example/a</link>
  <pubDate>Wed, 16 Sep 2026 08:15:00 GMT</pubDate>
  <description>${"word ".repeat(400)}</description>
</item></channel></rss>`;

export const OUTLETS = {
  northwind: { id: "northwind", name: "Northwind Wire", lean: "lean_left", country: "CA", feed: "https://northwind.example/rss", verified: true },
  southport: { id: "southport", name: "Southport Register", lean: "right", country: "CA", feed: "https://southport.example/atom", verified: true },
  meridianer: { id: "meridianer", name: "The Meridianer", lean: "centre", country: "CA", feed: "https://meridianer.example/rss", verified: true },
  statepress: { id: "statepress", name: "State Press Agency", lean: "state", country: "CN", feed: "https://statepress.example/rss", verified: true },
};

function item(outlet, title, url, excerpt, publishedAt = "2026-09-16T09:00:00Z") {
  return {
    outletId: outlet.id, outlet: outlet.name, lean: outlet.lean, country: outlet.country,
    title, url, excerpt, publishedAt, retrievedAt: "2026-09-16T12:00:00Z", via: "rss",
  };
}

/** Three outlets on one story, plus an unrelated story, plus a same-outlet repeat. */
export const MIXED_ITEMS = [
  item(OUTLETS.northwind, "Harbour authority raises dock fees by 12% after budget vote",
       "https://northwind.example/a", "The harbour authority approved a dock fee increase worth $20 million to operators."),
  item(OUTLETS.southport, "Dock fee rise of 12 percent confirmed by harbour authority",
       "https://southport.example/b", "Harbour authority confirmed the dock fee rise after a split budget vote."),
  item(OUTLETS.meridianer, "Harbour dock fees to rise 12% as budget vote splits council",
       "https://meridianer.example/c", "Council split over the harbour dock fee increase, which operators value at $28 million."),
  item(OUTLETS.northwind, "Harbour authority raises dock fees by 12% after budget vote (updated)",
       "https://northwind.example/a-updated", "Updated: the harbour authority approved the dock fee increase."),
  item(OUTLETS.meridianer, "Regional orchestra announces winter programme",
       "https://meridianer.example/d", "The orchestra will perform four concerts between December and February."),
];

/** A story covered only by off-axis outlets — rule 5 territory. */
export const OFF_AXIS_ITEMS = [
  item(OUTLETS.statepress, "Ministry rejects foreign criticism of port project financing",
       "https://statepress.example/x", "The ministry said the port financing followed international norms."),
  item({ ...OUTLETS.statepress, id: "diaspora", name: "Diaspora Daily", lean: "varies", country: "TW" },
       "Port project financing draws renewed criticism from island lawmakers",
       "https://diaspora.example/y", "Lawmakers questioned the port financing terms in a committee hearing."),
];

export const ROBOTS = `
# a comment
User-agent: BadBot
Disallow: /

User-agent: *
Disallow: /private
Allow: /private/public-feed.xml
Disallow:
`;
