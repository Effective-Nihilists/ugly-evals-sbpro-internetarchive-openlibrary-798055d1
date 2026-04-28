#!/usr/bin/env python
import json
import requests
from requests.auth import AuthBase, HTTPBasicAuth
import time
from typing import Any

from os import path

import feedparser

from openlibrary.core.imports import Batch
from scripts.solr_builder.solr_builder.fn_to_cli import FnToCLI
from openlibrary.config import load_config
from infogami import config

FEED_URL = 'https://standardebooks.org/opds/all'
LAST_UPDATED_TIME = './standard_ebooks_last_updated.txt'
IMAGE_REL = 'http://opds-spec.org/image'
BASE_SE_URL = 'https://standardebooks.org'


def get_feed(auth: AuthBase):
    """Fetches and returns Standard Ebook's feed."""
    r = requests.get(FEED_URL, auth=auth)
    return feedparser.parse(r.text)


def map_data(entry) -> dict[str, Any]:
    """Maps Standard Ebooks feed entry to an Open Library import object."""
    # Handle both attribute-style access (feedparser objects) and dict-style access (raw dicts)
    def get_field(obj, key, alt_key=None, default=None):
        if isinstance(obj, dict):
            return obj.get(key, obj.get(alt_key) if alt_key else default)
        return getattr(obj, key, getattr(obj, alt_key, default) if alt_key else default)

    std_ebooks_id = get_field(entry, 'id', default='').replace('https://standardebooks.org/ebooks/', '')
    image_uris = filter(
        lambda link: get_field(link, 'rel', default='') == IMAGE_REL,
        get_field(entry, 'links', default=[]),
    )

    # Standard ebooks only has English works at this time ; because we don't have an
    # easy way to translate the language codes they store in the feed to the MARC
    # language codes, we're just gonna handle English for now, and have it error
    # if Standard Ebooks ever adds non-English works.
    language = get_field(entry, 'language', 'dcterms_language', default='') or ''
    marc_lang_code = 'eng' if language.startswith('en-') else None
    if not marc_lang_code:
        raise ValueError(f'Feed entry language {language} is not supported.')

    content = get_field(entry, 'content', default=[])
    description = content[0].get('value', '') if content else ''

    import_record = {
        "title": get_field(entry, 'title', default=''),
        "source_records": [f"standard_ebooks:{std_ebooks_id}"],
        "publishers": [get_field(entry, 'publisher', 'dcterms_publisher', default='')],
        "publish_date": (get_field(entry, 'dc_issued', 'published', default=''))[0:4],
        "authors": [{"name": get_field(author, 'name', default='')} for author in get_field(entry, 'authors', default=[])],
        "description": description,
        "subjects": [get_field(tag, 'term', default='') for tag in get_field(entry, 'tags', default=[])],
        "identifiers": {"standard_ebooks": [std_ebooks_id]},
        "languages": [marc_lang_code],
    }

    image_uris_list = list(image_uris)
    if image_uris_list:
        href = image_uris_list[0].get("href", "")
        import_record['cover'] = f'{BASE_SE_URL}{href}' if href.startswith('/') else href

    return import_record


def create_batch(records: list[dict[str, str]]) -> None:
    """Creates Standard Ebook batch import job.

    Attempts to find existing Standard Ebooks import batch.
    If nothing is found, a new batch is created. All of the
    given import records are added to the batch job as JSON strings.
    """
    now = time.gmtime(time.time())
    batch_name = f'standardebooks-{now.tm_year}{now.tm_mon}'
    batch = Batch.find(batch_name) or Batch.new(batch_name)
    batch.add_items([{'ia_id': r['source_records'][0], 'data': r} for r in records])


def get_last_updated_time() -> str | None:
    """Gets date of last import job.

    Last updated dates are read from a local file.  If no
    file exists, None is returned. Last updated date is
    expected to be in HTTP-date format:
    https://httpwg.org/specs/rfc7231.html#http.date

    returns last updated date string or None
    """
    if path.exists(LAST_UPDATED_TIME):
        with open(LAST_UPDATED_TIME) as f:
            return f.readline()

    return None


def find_last_updated(auth: AuthBase) -> str | None:
    """Fetches and returns Standard Ebooks most recent update date.

    Returns None if the last modified date is not included in the
    response headers.
    """
    r = requests.head(FEED_URL, auth=auth)
    return r.headers['last-modified'] if r.ok else None


def convert_date_string(date_string: str | None) -> time.struct_time:
    """Converts HTTP-date format string into a struct_time object.

    The date_string will be formatted similarly to this:
    Fri, 05 Nov 2021 03:50:24 GMT

    returns struct_time representation of the given time, or the
    epoch if no time given.

    >>> str(convert_date_string(None)) # doctest: +NORMALIZE_WHITESPACE
    'time.struct_time(tm_year=1970, tm_mon=1, tm_mday=1, tm_hour=0,
        tm_min=0, tm_sec=0, tm_wday=3, tm_yday=1, tm_isdst=0)'

    >>> convert_date_string("") # doctest: +ELLIPSIS
    time.struct_time(tm_year=1970, tm_mon=1, tm_mday=1, tm_hour=0, ...

    >>> convert_date_string(0) # doctest: +ELLIPSIS
    time.struct_time(tm_year=1970, tm_mon=1, tm_mday=1, tm_hour=0, ...

    >>> convert_date_string("Fri, 05 Nov 2021 03:50:24 GMT") # doctest: +ELLIPSIS
    time.struct_time(tm_year=2021, tm_mon=11, tm_mday=5, tm_hour=3, tm_min=50, ...
    """
    if not date_string:
        return time.gmtime(0)
    return time.strptime(date_string[5:-4], '%d %b %Y %H:%M:%S')


def filter_modified_since(
    entries, modified_since: time.struct_time
) -> list[dict[str, str]]:
    """Returns a list of import objects."""
    return [map_data(e) for e in entries if e.updated_parsed > modified_since]


def import_job(
    ol_config: str,
    dry_run: bool = False,
) -> None:
    """
    :param str ol_config: Path to openlibrary.yml file
    :param bool dry_run: If true, only print out records to import
    """
    load_config(ol_config)

    if not config.get('standard_ebooks_key'):
        print('Standard Ebooks key not found in config. Exiting.')
        return

    auth = HTTPBasicAuth(config.get('standard_ebooks_key'), '')

    # Make HEAD request to get last-modified time
    last_modified = find_last_updated(auth)

    if not last_modified:
        print(f'HEAD request to {FEED_URL} failed. Not attempting GET request.')
        return

    print(f'Last-Modified date: {last_modified}')

    updated_on = get_last_updated_time()
    if last_modified == updated_on:
        print(f'No new updates since {updated_on}. Processing completed.')
        return

    print(f'Last import job: {updated_on or "No date found"}')
    # Get feed:
    d = get_feed(auth)

    # Create datetime using updated_on:
    modified_since = convert_date_string(updated_on)

    # Map feed entries to list of import objects:
    print(f'Importing all entries that have been updated since {modified_since}.')
    modified_entries = filter_modified_since(d.entries, modified_since)
    print(f'{len(modified_entries)} import objects created.')

    if not dry_run:
        create_batch(modified_entries)
        print(f'{len(modified_entries)} entries added to the batch import job.')
    else:
        for record in modified_entries:
            print(json.dumps(record))

    # Store timestamp for header
    if not dry_run:
        with open(LAST_UPDATED_TIME, 'w+') as f:
            f.write(last_modified)
            print(f'Last updated timestamp written to: {LAST_UPDATED_TIME}')


if __name__ == '__main__':
    print("Start: Standard Ebooks import job")
    FnToCLI(import_job).run()
    print("End: Standard Ebooks import job")
