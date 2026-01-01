# Installing AWS CLI on macOS

## Method 1: Using Homebrew (Recommended - Easiest)

Since you already have Homebrew installed, this is the simplest method:

```bash
brew install awscli
```

After installation, verify it worked:
```bash
aws --version
```

You should see something like: `aws-cli/2.x.x Python/3.x.x Darwin/xx.x.x source/x86_64`

---

## Method 2: Using Official AWS Installer

If Homebrew doesn't work, use the official installer:

1. **Download the installer:**
   ```bash
   curl "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o "AWSCLIV2.pkg"
   ```

2. **Install it:**
   ```bash
   sudo installer -pkg AWSCLIV2.pkg -target /
   ```

3. **Verify installation:**
   ```bash
   aws --version
   ```

4. **Clean up:**
   ```bash
   rm AWSCLIV2.pkg
   ```

---

## Method 3: Using pip (Python Package Manager)

If you have Python 3 installed:

```bash
pip3 install awscli
```

Or if you prefer to install for your user only:
```bash
pip3 install --user awscli
```

**Note:** Make sure `~/.local/bin` is in your PATH:
```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

---

## After Installation

Once AWS CLI is installed, configure it:

```bash
aws configure
```

You'll be prompted for:
1. **AWS Access Key ID** - Your AWS access key
2. **AWS Secret Access Key** - Your AWS secret key
3. **Default region name** - Enter `eu-central-1`
4. **Default output format** - Enter `json`

This creates `~/.aws/credentials` and `~/.aws/config` files.

---

## Verify Installation

```bash
# Check version
aws --version

# Test AWS connection (after configuring credentials)
aws sts get-caller-identity
```

---

## Troubleshooting

### "aws: command not found"
- Make sure the installation completed successfully
- Check your PATH includes the AWS CLI location
- Try restarting your terminal

### Homebrew permission errors
If you get permission errors with Homebrew:
```bash
sudo chown -R $(whoami) /opt/homebrew
```

### Check if already installed
```bash
which aws
aws --version
```

---

## Next Steps

After installing and configuring AWS CLI:

1. **Verify your setup:**
   ```bash
   aws sts get-caller-identity
   ```

2. **Install Serverless Framework** (if not already):
   ```bash
   # Install latest 3.x version (required for this project)
   npm install -g serverless@^3
   
   # Or install specific latest 3.x version
   npm install -g serverless@3
   ```
   
   **Verify version:**
   ```bash
   serverless --version
   # Should show: Framework Core: 3.x.x
   ```
   
   **Note:** This project requires Serverless Framework 3.x (specified in `serverless.yml` as `frameworkVersion: '3'`). Version 4.x is not compatible.

3. **Install project dependencies:**
   ```bash
   cd /Users/mfmz/podpdf-be
   npm install
   ```

4. **Deploy to dev:**
   ```bash
   serverless deploy --stage dev
   ```

