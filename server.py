#!/usr/bin/env python3
"""Local HTTP bridge between the NetPulse web console and dpi_engine."""
from __future__ import annotations
import json, mimetypes, os, re, shutil, subprocess, threading, time, uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT /