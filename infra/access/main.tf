terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "= 5.10.1"
    }
  }
}

variable "account_id" { type = string }
variable "hostname" { type = string }
variable "login_method_ids" {
  type        = set(string)
  description = "Access identity provider IDs shown on the planner sign-in page and accepted by its Allow policy."
  validation {
    condition     = length(var.login_method_ids) > 0
    error_message = "Specify at least one planner login method."
  }
}

resource "cloudflare_zero_trust_access_policy" "planner" {
  account_id = var.account_id
  name       = "2do planner sign-in"
  decision   = "allow"
  include    = [for id in sort(tolist(var.login_method_ids)) : { login_method = { id = id } }]
}

resource "cloudflare_zero_trust_access_application" "planner" {
  account_id       = var.account_id
  name             = "2do planner"
  type             = "self_hosted"
  session_duration = "24h"
  allowed_idps     = sort(tolist(var.login_method_ids))
  destinations = [
    for path in ["app", "app/*", "api", "api/*"] :
    { type = "public", uri = "${var.hostname}/${path}" }
  ]
  policies = [{ id = cloudflare_zero_trust_access_policy.planner.id, precedence = 1 }]
}

output "access_aud" { value = cloudflare_zero_trust_access_application.planner.aud }
