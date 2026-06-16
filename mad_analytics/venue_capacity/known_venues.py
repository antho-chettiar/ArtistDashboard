"""
Known venue capacities — curated database of verified venue sizes.
This is the most reliable source (higher priority than web search or heuristic).
Add venues here as you verify them manually.
"""
from __future__ import annotations
from typing import Optional

# Format: (venue_name_lowercase, city_lowercase): capacity
KNOWN_VENUES: dict[tuple[str, str], int] = {
    # USA
    ("madison square garden", "new york"): 20000,
    ("madison square garden", "new york (nyc)"): 20000,
    ("crypto.com arena", "los angeles"): 20000,
    ("crypto.com arena", "los angeles (la)"): 20000,
    ("state farm arena", "atlanta"): 17000,
    ("bridgestone arena", "nashville"): 20000,
    ("kia center", "orlando"): 17000,
    ("hard rock live", "hollywood"): 7000,
    ("hard rock live at etess arena", "atlantic city"): 7000,
    ("hard rock stadium", "miami gardens"): 65000,
    ("chase center", "san francisco"): 18064,
    ("american airlines center", "dallas"): 20000,
    ("allstate arena", "rosemont"): 18500,
    ("prudential center", "newark"): 18000,
    ("barclays center", "brooklyn"): 19000,
    ("td garden", "boston"): 19580,
    ("united center", "chicago"): 20917,
    ("caesars superdome", "new orleans"): 73000,
    ("lucas oil stadium", "indianapolis"): 67000,
    ("shoreline amphitheatre", "mountain view"): 22500,
    ("oakland arena", "oakland"): 19596,
    ("sap center", "san jose"): 17496,
    ("smart financial centre", "sugar land"): 6400,
    ("arena theatre", "houston"): 2850,
    ("the grand center", "plano"): 3500,
    ("9:30 club", "washington"): 1200,
    ("bowery ballroom", "new york"): 575,
    ("masonic auditorium", "san francisco"): 3300,
    ("shrine auditorium", "los angeles"): 6300,
    ("shrine auditorium", "los angeles (la)"): 6300,
    ("clowes memorial hall", "indianapolis"): 2148,

    # Canada
    ("scotiabank arena", "toronto"): 19800,
    ("rogers centre", "toronto"): 49000,
    ("rogers place", "edmonton"): 18347,
    ("scotiabank saddledome", "calgary"): 19289,
    ("air canada centre", "toronto"): 19800,
    ("canada life centre", "winnipeg"): 15321,
    ("meridian hall", "toronto"): 3191,
    ("rebel", "toronto"): 2500,
    ("danforth music hall", "toronto"): 1500,
    ("td coliseum", "hamilton"): 17383,
    ("rose theatre", "brampton"): 868,

    # UK
    ("the o2 arena", "london"): 20000,
    ("the o2", "london"): 20000,
    ("the o2", "greenwich"): 20000,
    ("wembley stadium", "london"): 90000,
    ("co-op live", "manchester"): 23500,
    ("ao arena", "manchester"): 21000,
    ("ovo hydro", "glasgow"): 14300,
    ("the ovo hydro", "glasgow"): 14300,
    ("utilita arena", "birmingham"): 15800,
    ("utilita arena birmingham", "birmingham"): 15800,
    ("o2 forum kentish town", "london"): 2300,

    # Europe
    ("accor arena", "paris"): 20300,
    ("lanxess arena", "cologne"): 18500,
    ("uber arena", "berlin"): 17000,
    ("barclays arena", "hamburg"): 16000,
    ("olympiahalle", "munich"): 15500,
    ("unipol forum", "assago"): 12700,
    ("royal arena", "copenhagen"): 16000,
    ("avicii arena", "stockholm"): 16000,
    ("ahoy", "rotterdam"): 15818,
    ("ziggo dome", "amsterdam"): 17000,

    # Australia
    ("rod laver arena", "melbourne"): 15000,
    ("qudos bank arena", "sydney"): 21000,
    ("commbank stadium", "sydney"): 30000,
    ("aami park", "melbourne"): 30050,
    ("rac arena", "perth"): 15500,
    ("tiktok entertainment centre", "sydney"): 9000,
    ("hordern pavilion", "sydney"): 5500,

    # New Zealand
    ("spark arena", "auckland"): 12000,
    ("the trusts arena", "auckland"): 5100,

    # India
    ("jawaharlal nehru stadium", "delhi"): 60000,
    ("jawaharlal nehru stadium", "shillong"): 40000,
    ("mahalaxmi race course", "mumbai"): 30000,
    ("shanmukhananda auditorium", "mumbai"): 2500,
    ("terraform", "bangalore"): 5000,
    ("roxanne`s bar & all day diner", "mumbai"): 250,

    # UAE
    ("expo city dubai", "dubai"): 4000,
    ("coca-cola arena", "dubai"): 17000,
    ("dubai duty free tennis stadium", "dubai"): 5000,
    ("dubai tennis stadium", "dubai"): 5000,

    # Singapore
    ("singapore indoor stadium", "singapore"): 12000,
    ("capitol theatre", "singapore"): 930,

    # Indonesia
    ("britama arena, mahaka square", "kota administrasi jakarta utara"): 7000,

    # ── Additional venues (researched) ─────────────────────────────────────

    # USA - additional
    ("agganis arena", "boston"): 7200,
    ("amalie arena", "tampa"): 20500,
    ("bc place stadium", "vancouver"): 54500,
    ("eaglebank arena", "fairfax"): 10000,
    ("filene center", "vienna"): 7000,
    ("gas south arena", "duluth"): 13000,
    ("grand ole opry house", "nashville"): 4400,
    ("great lawn in central park", "new york"): 80000,
    ("hard rock live at the etess arena", "atlantic city"): 7000,
    ("lenovo center", "raleigh"): 5500,
    ("now arena", "hoffman estates"): 11000,
    ("royale", "boston"): 1200,
    ("sun national bank center", "trenton"): 8600,
    ("terminal west", "atlanta"): 1000,
    ("terrace theater", "long beach"): 3051,
    ("texas trust cu theatre", "grand prairie"): 6350,
    ("the regency ballroom", "san francisco"): 1000,
    ("the studio", "dallas"): 400,
    ("the tonight show starring jimmy fallon", "new york"): 215,

    # Canada - additional
    ("commodore ballroom", "vancouver"): 990,
    ("history", "toronto"): 2500,
    ("the theatre at great canadian casino", "toronto"): 5000,

    # UK - additional
    ("manchester academy 2, university of manchester", "manchester"): 950,
    ("theatre royal drury lane", "london"): 2196,
    ("tottenham hotspur stadium", "london"): 62850,

    # Germany - additional
    ("batschkapp", "frankfurt"): 1500,
    ("columbia theater", "berlin"): 850,
    ("frannz club", "berlin"): 500,

    # France - additional
    ("le trabendo", "paris"): 700,

    # Ireland - additional
    ("the academy", "dublin"): 900,
    ("the convention centre dublin", "dublin"): 2000,

    # Australia - additional
    ("adelaide entertainment centre", "adelaide"): 11300,
    ("brisbane convention centre", "brisbane"): 4000,
    ("brisbane entertainment centre", "brisbane"): 13500,
    ("corner hotel", "melbourne"): 500,
    ("enmore theatre", "newtown"): 1600,
    ("evan theatre", "penrith"): 2000,
    ("forum melbourne", "melbourne"): 1500,
    ("liberty hall", "sydney"): 800,
    ("lion arts factory", "adelaide"): 400,
    ("margaret court arena", "melbourne"): 7500,
    ("metro theatre", "sydney"): 1150,
    ("palais theatre", "melbourne"): 2896,
    ("riverside theatre", "perth"): 900,
    ("sleeman centre", "brisbane"): 5000,
    ("the brightside", "brisbane"): 400,
    ("the triffid", "newstead"): 400,
    ("trak lounge bar", "melbourne"): 200,
    ("amplifier", "perth"): 700,

    # Denmark
    ("royal arena", "copenhagen"): 16000,

    # Sweden
    ("avicii arena", "stockholm"): 16000,
}


def lookup_known_capacity(venue_name: str, city: str) -> Optional[int]:
    """Look up a venue in the known venues database. Returns capacity or None."""
    if not venue_name:
        return None

    key = (venue_name.lower().strip(), city.lower().strip())
    capacity = KNOWN_VENUES.get(key)
    if capacity:
        return capacity

    # Try partial match (venue name contains known venue)
    venue_lower = venue_name.lower().strip()
    city_lower = city.lower().strip()
    for (known_venue, known_city), cap in KNOWN_VENUES.items():
        if known_venue in venue_lower and known_city in city_lower:
            return cap
        if venue_lower in known_venue and city_lower in known_city:
            return cap

    return None
