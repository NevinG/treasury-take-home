# Deploying to Azure

The app deploys as a **single Azure Linux App Service**: the Express backend serves the
API *and* the built React frontend. Infrastructure is defined in Terraform (`infra/`) and
a GitHub Actions workflow (`.github/workflows/deploy.yml`) redeploys on every push to
`main`.

- **Cost:** defaults to the **F1 Free** App Service plan ($0). Bump `sku_name` to `B1`
  (~$13/mo) for always-on / more CPU.
- **One-time setup** is below; after that, `git push` to `main` deploys automatically.

## Prerequisites (install once)

- An Azure subscription
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) — then `az login`
- [Terraform](https://developer.hashicorp.com/terraform/install) ≥ 1.5

## Step 1 — Create the infrastructure with Terraform

```bash
az login                                            # if you haven't already
az account set --subscription "<your-subscription>" # pick the target subscription

cd infra
cp terraform.tfvars.example terraform.tfvars      # then put your Gemini key in it
terraform init
terraform apply                                    # review, type "yes"
```

When it finishes it prints outputs, e.g.:

```
app_name  = "ttb-label-verify-ab12cd"
app_url   = "https://ttb-label-verify-ab12cd.azurewebsites.net"
```

Note the **app_name** and **app_url**.

## Step 2 — Give GitHub Actions permission to deploy

1. Download the App Service **publish profile** (deployment credentials):

   ```bash
   az webapp deployment list-publishing-profiles \
     --name <app_name> --resource-group ttb-label-verify-rg --xml
   ```

   Copy the entire XML output.

2. In your GitHub repo → **Settings → Secrets and variables → Actions**:
   - **New repository secret**: `AZURE_WEBAPP_PUBLISH_PROFILE` = the XML from above.
   - **Variables** tab → **New repository variable**: `AZURE_WEBAPP_NAME` = the `app_name`
     from Step 1.

## Step 3 — Deploy

Push to `main` (or run the workflow manually from the **Actions** tab):

```bash
git push origin main
```

The workflow builds the frontend, bundles it with the backend + the offline OCR model,
and deploys to App Service. When it finishes, open the **app_url**.

The Gemini key is already configured (Terraform set it as the `GEMINI_API_KEY` app
setting). To rotate it later: `az webapp config appsettings set --name <app_name>
--resource-group ttb-label-verify-rg --settings GEMINI_API_KEY=<newkey>` (or re-apply
Terraform).

## Updating / tearing down

- **Update infra** (e.g. change SKU): edit `infra/*.tf`, then `terraform apply`.
- **Tear down everything:** `cd infra && terraform destroy`.

## Notes

- The first request after an idle period on **F1** is slow (cold start, no always-on).
- `GEMINI_API_KEY` is stored in Terraform state (sensitive) and as an App Service
  setting. Keep `terraform.tfstate` private (it's git-ignored).
- If Azure's outbound network can't reach Google, the app automatically falls back to the
  on-device engine (see the README's Offline mode), so verification still works.
