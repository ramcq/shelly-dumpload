#!/usr/bin/env python3
"""
Shelly Script Deployment Tool
Uploads JavaScript scripts to multiple Shelly devices via HTTP API
Handles chunked uploads for scripts > 1024 bytes
"""

import sys
import json
import requests
import argparse
from pathlib import Path

# ANSI color codes
class Color:
    RED = '\033[0;31m'
    GREEN = '\033[0;32m'
    YELLOW = '\033[1;33m'
    BLUE = '\033[0;34m'
    NC = '\033[0m'  # No Color

def read_config(config_file: Path) -> list[dict]:
    """Read deployment configuration from file."""
    deployments = []

    with open(config_file, 'r') as f:
        for line_num, line in enumerate(f, 1):
            line = line.strip()

            # Skip empty lines and comments
            if not line or line.startswith('#'):
                continue

            parts = line.split(':')
            if len(parts) != 4:
                print(f"{Color.RED}Error on line {line_num}: Expected format 'IP:SCRIPT_ID:FILE:NAME'{Color.NC}")
                sys.exit(1)

            device_ip, script_id, script_file, script_name = parts

            deployments.append({
                'ip': device_ip.strip(),
                'script_id': int(script_id.strip()),
                'script_file': script_file.strip(),
                'script_name': script_name.strip()
            })

    return deployments

def rpc_call(device_ip: str, method: str, params: dict = None) -> dict:
    """Make an RPC call to a Shelly device."""
    url = f"http://{device_ip}/rpc/{method}"

    try:
        if params:
            # Use explicit JSON encoding with UTF-8, matching official Shelly script
            req_data = json.dumps(params, ensure_ascii=False)
            response = requests.post(url, data=req_data.encode("utf-8"), timeout=10)
        else:
            response = requests.get(url, timeout=10)

        response.raise_for_status()
        return response.json()
    except requests.exceptions.HTTPError as e:
        # Capture full error details
        error_msg = f"HTTP {e.response.status_code}: {e.response.reason}"
        try:
            error_msg += f"\nResponse body: {e.response.text}"
        except:
            pass
        try:
            if params and 'code' in params:
                code_preview = params['code'][:100] if len(params['code']) > 100 else params['code']
                error_msg += f"\nCode chunk preview: {repr(code_preview)}"
        except:
            pass
        raise Exception(f"RPC call failed: {error_msg}")
    except requests.exceptions.RequestException as e:
        raise Exception(f"RPC call failed: {e}")

def script_exists(device_ip: str, script_id: int) -> bool:
    """Check if a script with the given ID exists on the device."""
    try:
        result = rpc_call(device_ip, "Script.GetStatus", {"id": script_id})
        return result.get('code') != -1
    except:
        return False

def create_script(device_ip: str, script_id: int, script_name: str):
    """Create a new script on the device."""
    print(f"{Color.YELLOW}  Creating new script...{Color.NC}")
    rpc_call(device_ip, "Script.Create", {
        "id": script_id,
        "name": script_name
    })

def upload_script_chunked(device_ip: str, script_id: int, script_code: str):
    """Upload script code in chunks (required for scripts > 1024 bytes)."""
    chunk_size = 1024
    total_len = len(script_code)

    print(f"{Color.YELLOW}  Uploading script code ({total_len} bytes)...{Color.NC}")

    # First chunk - clear existing code
    chunk = script_code[:chunk_size]
    rpc_call(device_ip, "Script.PutCode", {
        "id": script_id,
        "code": chunk,
        "append": False
    })

    offset = chunk_size
    chunk_num = 2

    # Remaining chunks - append
    while offset < total_len:
        chunk = script_code[offset:offset + chunk_size]
        print(f"{Color.YELLOW}    Chunk {chunk_num} ({offset}/{total_len} bytes)...{Color.NC}")

        rpc_call(device_ip, "Script.PutCode", {
            "id": script_id,
            "code": chunk,
            "append": True
        })

        offset += chunk_size
        chunk_num += 1

    print(f"{Color.GREEN}  ✓ Upload complete{Color.NC}")

def enable_script(device_ip: str, script_id: int):
    """Enable a script to run."""
    print(f"{Color.YELLOW}  Enabling script...{Color.NC}")
    rpc_call(device_ip, "Script.SetConfig", {
        "id": script_id,
        "config": {"enable": True}
    })

def stop_script(device_ip: str, script_id: int):
    """Stop a running script."""
    try:
        rpc_call(device_ip, "Script.Stop", {"id": script_id})
    except:
        pass  # Ignore errors if script wasn't running

def start_script(device_ip: str, script_id: int):
    """Start a script."""
    print(f"{Color.YELLOW}  Starting script...{Color.NC}")
    result = rpc_call(device_ip, "Script.Start", {"id": script_id})
    return result

def deploy_script(deployment: dict) -> bool:
    """Deploy a single script to a device."""
    device_ip = deployment['ip']
    script_id = deployment['script_id']
    script_file = deployment['script_file']
    script_name = deployment['script_name']

    print(f"{Color.BLUE}Deploying {script_name} to {device_ip} (ID: {script_id})...{Color.NC}")

    # Check if script file exists
    script_path = Path(script_file)
    if not script_path.exists():
        print(f"{Color.RED}  Error: Script file '{script_file}' not found{Color.NC}")
        return False

    # Read script code
    with open(script_path, 'r') as f:
        script_code = f.read()

    try:
        # Check if script exists and stop it if running (required before upload)
        exists = script_exists(device_ip, script_id)
        if exists:
            print(f"{Color.YELLOW}  Stopping running script...{Color.NC}")
            stop_script(device_ip, script_id)
        else:
            create_script(device_ip, script_id, script_name)

        # Upload script code (chunked)
        upload_script_chunked(device_ip, script_id, script_code)

        # Enable script
        enable_script(device_ip, script_id)

        # Start script
        print(f"{Color.YELLOW}  Starting script...{Color.NC}")
        start_script(device_ip, script_id)

        print(f"{Color.GREEN}  ✓ Successfully deployed and started{Color.NC}")
        return True

    except Exception as e:
        print(f"{Color.RED}  ✗ Deployment failed: {e}{Color.NC}")
        return False

def main():
    parser = argparse.ArgumentParser(
        description='Deploy scripts to Shelly devices',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
Configuration file format (one deployment per line):
  DEVICE_IP:SCRIPT_ID:SCRIPT_FILE:SCRIPT_NAME

Example deploy.conf:
  192.168.1.100:1:smart-load-controller.js:Smart Load
  192.168.1.101:1:thermal-dump-controller.js:Thermal Dump
  # Lines starting with # are comments
        '''
    )

    parser.add_argument(
        'config',
        nargs='?',
        default='deploy.conf',
        help='Configuration file (default: deploy.conf)'
    )

    parser.add_argument(
        '--device',
        help='Deploy only to specific device IP'
    )

    args = parser.parse_args()

    # Read configuration
    config_path = Path(args.config)
    if not config_path.exists():
        print(f"{Color.RED}Error: Configuration file '{args.config}' not found{Color.NC}")
        print("\nCreate a deploy.conf file with format:")
        print("  DEVICE_IP:SCRIPT_ID:SCRIPT_FILE:SCRIPT_NAME")
        sys.exit(1)

    deployments = read_config(config_path)

    # Filter by device if specified
    if args.device:
        deployments = [d for d in deployments if d['ip'] == args.device]
        if not deployments:
            print(f"{Color.RED}No deployments found for device {args.device}{Color.NC}")
            sys.exit(1)

    # Deploy to all devices
    print(f"{Color.GREEN}=== Shelly Script Deployment ==={Color.NC}\n")

    total = len(deployments)
    success = 0
    failed = 0

    for deployment in deployments:
        if deploy_script(deployment):
            success += 1
        else:
            failed += 1
        print()

    # Summary
    print(f"{Color.BLUE}=== Deployment Summary ==={Color.NC}")
    print(f"Total:   {total}")
    print(f"{Color.GREEN}Success: {success}{Color.NC}")

    if failed > 0:
        print(f"{Color.RED}Failed:  {failed}{Color.NC}")
        sys.exit(1)
    else:
        print(f"{Color.GREEN}All deployments successful!{Color.NC}")
        sys.exit(0)

if __name__ == '__main__':
    main()
