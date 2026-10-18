#!/usr/bin/env python3
"""One-time Strava authorisation for RunLog's Strava upload destination.

Strava only hands out refresh tokens through an OAuth browser login, so run
this once on a computer to get one, then paste the printed values into the
RunLog phone page (Destination: Strava).

    python3 tools/strava_auth.py <client_id> <client_secret>

Create the API application first at https://www.strava.com/settings/api and
set its "Authorization Callback Domain" to: localhost
Standard library only; nothing is stored on disk.
"""
import http.server
import json
import sys
import urllib.parse
import urllib.request
import webbrowser

PORT = 8723
REDIRECT = 'http://localhost:%d/' % PORT
SCOPE = 'activity:write,activity:read'


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    client_id, client_secret = sys.argv[1], sys.argv[2]
    auth_url = 'https://www.strava.com/oauth/authorize?' + urllib.parse.urlencode({
        'client_id': client_id,
        'response_type': 'code',
        'redirect_uri': REDIRECT,
        'approval_prompt': 'force',
        'scope': SCOPE,
    })
    result = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if 'code' not in q and 'error' not in q:
                self.send_response(404)
                self.end_headers()
                return
            result.update({k: v[0] for k, v in q.items()})
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.end_headers()
            self.wfile.write(b'Done - you can close this tab and return to the terminal.')

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(('localhost', PORT), Handler)
    print('Open this URL and approve access (it may open by itself):\n\n  %s\n' % auth_url)
    webbrowser.open(auth_url)
    while not result:
        server.handle_request()
    server.server_close()

    if 'error' in result:
        sys.exit('Strava returned an error: %s' % result['error'])
    granted = result.get('scope', '').split(',')
    if 'activity:write' not in granted:
        sys.exit('activity:write was not granted (got: %s). Run again and leave '
                 '"Upload your activities" ticked.' % (result.get('scope') or 'nothing'))

    body = urllib.parse.urlencode({
        'client_id': client_id,
        'client_secret': client_secret,
        'code': result['code'],
        'grant_type': 'authorization_code',
    }).encode()
    try:
        with urllib.request.urlopen('https://www.strava.com/oauth/token', body) as resp:
            token = json.load(resp)
    except urllib.error.HTTPError as e:
        sys.exit('Token exchange failed (HTTP %d): %s' % (e.code, e.read().decode(errors='replace')))

    athlete = token.get('athlete') or {}
    print('Authorised as %s %s.\n' % (athlete.get('firstname', ''), athlete.get('lastname', '')))
    print('Enter these on the RunLog phone page (Destination: Strava):')
    print('  Strava client ID:      %s' % client_id)
    print('  Strava client secret:  %s' % client_secret)
    print('  Strava refresh token:  %s' % token['refresh_token'])


if __name__ == '__main__':
    main()
