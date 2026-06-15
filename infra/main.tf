terraform {
  required_version = ">= 1.5"
  required_providers {
    # v3 infers the subscription from `az login` (no extra config needed). To move to
    # v4, set ARM_SUBSCRIPTION_ID (or provider subscription_id).
    azurerm = { source = "hashicorp/azurerm", version = "~> 3.116" }
    random  = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

provider "azurerm" {
  features {}
}

# App Service names must be globally unique — add a short random suffix.
resource "random_string" "suffix" {
  length  = 6
  special = false
  upper   = false
}

locals {
  app_name = "${var.app_name_prefix}-${random_string.suffix.result}"
}

resource "azurerm_resource_group" "rg" {
  name     = var.resource_group_name
  location = var.location
}

resource "azurerm_service_plan" "plan" {
  name                = "${var.app_name_prefix}-plan"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  os_type             = "Linux"
  sku_name            = var.sku_name # F1 = free; B1 (~$13/mo) for always-on / more CPU
}

resource "azurerm_linux_web_app" "app" {
  name                = local.app_name
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  service_plan_id     = azurerm_service_plan.plan.id

  site_config {
    always_on        = var.sku_name != "F1" # not allowed on the free tier
    app_command_line = "npm start"
    application_stack {
      node_version = "20-lts"
    }
  }

  app_settings = {
    GEMINI_API_KEY                 = var.gemini_api_key
    SCM_DO_BUILD_DURING_DEPLOYMENT = "false" # we deploy a prebuilt package from CI
    WEBSITE_NODE_DEFAULT_VERSION   = "~20"
  }
}
