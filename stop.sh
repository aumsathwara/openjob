#!/bin/bash
pkill -f "uvicorn.*server:app" 2>/dev/null && echo "▸ Backend stopped." || echo "▸ Backend was not running."
