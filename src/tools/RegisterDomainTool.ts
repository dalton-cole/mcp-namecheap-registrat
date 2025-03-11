import { MCPTool } from "mcp-framework";
import { z } from "zod";
import axios from "axios";
import * as xml2js from "xml2js";
import { detectPublicIp, resetIpCache } from "../utils/ipDetection.js";
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface RegisterDomainInput {
  domain: string;
  years?: number;
  nameservers?: string;
  confirmPurchase?: boolean;
  enableWhoisPrivacy?: boolean;
}

// Interface for registrant contact information
interface RegistrantProfile {
  firstName: string;
  lastName: string;
  organization?: string;
  address1: string;
  address2?: string;
  city: string;
  stateProvince: string;
  postalCode: string;
  country: string;
  phone: string;
  email: string;
}

class RegisterDomainTool extends MCPTool<RegisterDomainInput> {
  name = "register_domain";
  description = "Start the process of registering a domain name";

  schema = {
    domain: {
      type: z.string(),
      description: "Domain name to register (e.g., example.com)",
    },
    years: {
      type: z.number().optional(),
      description: "Number of years to register the domain for (default: 1)",
    },
    nameservers: {
      type: z.string().optional(),
      description: "Optional comma-separated list of nameservers",
    },
    confirmPurchase: {
      type: z.boolean().optional(),
      description: "Set to true to confirm and complete the purchase (default: false)",
    },
    enableWhoisPrivacy: {
      type: z.boolean().optional(),
      description: "Enable WhoisGuard privacy protection (default: true)",
    }
  };

  async execute(input: RegisterDomainInput) {
    const { 
      domain, 
      years = 1, 
      nameservers, 
      confirmPurchase = false,
      enableWhoisPrivacy = true 
    } = input;
    
    try {
      // Check availability first
      const apiResponse = await this.callNamecheapApi('namecheap.domains.check', {
        DomainList: domain
      });
      
      const result = apiResponse.CommandResponse.DomainCheckResult;
      const available = result.$.Available === 'true';
      const isPremium = result.$.IsPremiumName === 'true';
      
      if (!available) {
        return this.formatErrorResponse(`Domain ${domain} is not available for registration.`);
      }
      
      // Try to load registrant profile
      let registrantProfile: RegistrantProfile | null = null;
      try {
        registrantProfile = this.loadRegistrantProfile();
      } catch (profileError) {
        return this.formatErrorResponse(`
Domain ${domain} is available for registration!

However, I could not find a registrant profile for contact information.
Please create a file named "registrant-profile.json" in the project root with your contact details.
You can use "registrant-profile.example.json" as a template.
`);
      }
      
      // Get domain pricing information
      let pricingInfo: string;
      try {
        pricingInfo = await this.getDomainPricing(domain, years);
      } catch (pricingError) {
        pricingInfo = 'Pricing information unavailable';
      }
      
      // Display domain registration information and pricing
      const formattedProfile = this.formatProfileForDisplay(registrantProfile);
      
      // If this is not a purchase confirmation, show registration details
      if (!confirmPurchase) {
        const premiumWarning = isPremium ? `
⚠️ PREMIUM DOMAIN NOTICE ⚠️
This is a premium domain name that may have a higher registration fee than standard domains.
` : '';
        
        return `
Domain ${domain} is available for registration!
${premiumWarning}
${pricingInfo}

Registration details:
- Domain: ${domain}
- Period: ${years} year(s)
${nameservers ? `- Custom nameservers: ${nameservers}` : '- Default nameservers will be used'}
- WhoisGuard Privacy: ${enableWhoisPrivacy ? 'Enabled' : 'Disabled'}

Contact information from your registrant profile:
${formattedProfile}

To complete the registration, run this command again with confirmPurchase=true.
⚠️ Your Namecheap account will be charged for this purchase. ⚠️
`;
      }
      
      // If we get here, the user has confirmed they want to purchase the domain
      
      // Format the contact information for the API
      const contactInfo = this.formatContactInfoForApi(registrantProfile);
      
      // If custom nameservers are provided, add them to the API parameters
      const nameserversParam: Record<string, string> = {};
      if (nameservers) {
        const nameserverList = nameservers.split(',').map(ns => ns.trim());
        nameserverList.forEach((ns, index) => {
          nameserversParam[`Nameserver${index + 1}`] = ns;
        });
      }
      
      // Build parameters for domain creation
      try {
        // Make API call to register the domain
        const domainResponse = await this.callNamecheapApi('namecheap.domains.create', {
          DomainName: domain,
          Years: years.toString(),
          AddFreeWhoisguard: enableWhoisPrivacy ? 'yes' : 'no',
          WGEnabled: enableWhoisPrivacy ? 'yes' : 'no',
          ...contactInfo,
          ...nameserversParam
        });
        
        // Check if the domain was successfully registered
        if (domainResponse.CommandResponse && domainResponse.CommandResponse.DomainCreateResult) {
          const createResult = domainResponse.CommandResponse.DomainCreateResult;
          
          // If OrderID is present, the domain was registered successfully
          if (createResult.$ && createResult.$.OrderID) {
            return `
✅ Success! Domain ${domain} has been registered!

Order ID: ${createResult.$.OrderID}
Transaction ID: ${createResult.$.TransactionID}
Registration Date: ${createResult.$.RegisterDate || 'Immediate'}

WhoisGuard: ${enableWhoisPrivacy ? 'Enabled' : 'Disabled'}
Nameservers: ${nameservers || 'Default Namecheap DNS'}

You can manage your new domain through your Namecheap account dashboard.
`;
          }
        }
        
        // If we didn't get expected response format
        return this.formatErrorResponse(`
Something went wrong with the domain registration process.
Please check your Namecheap account to see if the domain was registered.
The API response did not contain the expected confirmation details.
`);
      } catch (purchaseError) {
        // Detailed error message for purchase failures
        return this.formatErrorResponse(`
⚠️ Domain purchase failed!

There was an error while attempting to register ${domain}:
${purchaseError instanceof Error ? purchaseError.message : 'Unknown error'}

No charges have been applied to your account. Please try again later or check
your Namecheap account status and API limits.
`);
      }
    } catch (error) {
      if (error instanceof Error) {
        return this.formatErrorResponse(`Error registering domain: ${error.message}`);
      }
      return this.formatErrorResponse(`Error registering domain: Unknown error`);
    }
  }

  private async getDomainPricing(domain: string, years: number): Promise<string> {
    try {
      const parts = domain.split('.');
      if (parts.length < 2) {
        return 'Pricing information unavailable - invalid domain format';
      }
      
      const tld = parts[parts.length - 1];
      
      // Call the pricing API
      const apiResponse = await this.callNamecheapApi('namecheap.users.getPricing', {
        ProductType: 'DOMAIN',
        ActionName: 'REGISTER',
        ProductName: tld
      });
      
      if (apiResponse && apiResponse.CommandResponse && apiResponse.CommandResponse[0].UserGetPricingResult) {
        const pricingResult = apiResponse.CommandResponse[0].UserGetPricingResult[0];
        
        // Find the domain product type
        const domainType = pricingResult.ProductType.find((type: any) => 
          type.$.Name.toLowerCase() === 'domain' || type.$.Name.toLowerCase() === 'domains'
        );
        
        if (!domainType || !domainType.ProductCategory) {
          return 'Pricing information unavailable';
        }
        
        // Find the registration category
        const regCategory = domainType.ProductCategory.find((cat: any) => 
          cat.$.Name.toLowerCase() === 'register'
        );
        
        if (!regCategory || !regCategory.Product) {
          return 'Registration pricing information unavailable';
        }
        
        // Find the specific TLD product
        const tldProduct = regCategory.Product.find((p: any) => 
          p.$.Name.toLowerCase() === tld.toLowerCase()
        );
        
        if (!tldProduct || !tldProduct.Price) {
          return 'TLD pricing information unavailable';
        }
        
        // Find the price for the requested years
        const yearPrice = tldProduct.Price.find((price: any) => 
          price.$.Duration === years.toString() && price.$.DurationType === 'YEAR'
        );
        
        if (yearPrice) {
          return `Pricing: $${yearPrice.$.YourPrice} for ${years} year(s)`;
        } else {
          // If specific year pricing not found, return the first available
          const firstPrice = tldProduct.Price[0];
          return `Pricing: $${firstPrice.$.YourPrice} per year`;
        }
      }
      
      return 'Pricing information unavailable';
    } catch (error) {
      return 'Pricing information unavailable due to an error';
    }
  }

  private loadRegistrantProfile(): RegistrantProfile {
    // Try multiple strategies to find the profile
    let profilePath = '';
    let profile: RegistrantProfile | null = null;
    
    // Strategy 1: Using current working directory
    const cwd = process.cwd();
    const cwdProfilePath = path.join(cwd, 'registrant-profile.json');
    
    // Strategy 2: Using path relative to this file
    const thisFilePath = __dirname; // Should be dist/tools
    const projectRoot = path.resolve(thisFilePath, '../..');
    const relativeProfilePath = path.join(projectRoot, 'registrant-profile.json');
    
    // Strategy 3: Using absolute path (fallback)
    const possiblePaths = [
      cwdProfilePath,
      relativeProfilePath,
      // Add any other potential locations here
    ];
    
    for (const potentialPath of possiblePaths) {
      if (fs.existsSync(potentialPath)) {
        profilePath = potentialPath;
        break;
      }
    }
    
    if (!profilePath) {
      throw new Error('Registrant profile not found. Please create a registrant-profile.json file in the project root.');
    }
    
    try {
      const profileData = fs.readFileSync(profilePath, 'utf8');
      profile = JSON.parse(profileData) as RegistrantProfile;
      
      // Validate the profile has required fields
      const requiredFields = ['firstName', 'lastName', 'address1', 'city', 
                              'stateProvince', 'postalCode', 'country', 
                              'phone', 'email'];
      
      for (const field of requiredFields) {
        if (!profile[field as keyof RegistrantProfile]) {
          throw new Error(`Registrant profile is missing required field: ${field}`);
        }
      }
      
      return profile;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error('Registrant profile contains invalid JSON. Please check the format.');
      }
      throw error;
    }
  }
  
  private formatProfileForDisplay(profile: RegistrantProfile): string {
    return `- Name: ${profile.firstName} ${profile.lastName}
${profile.organization ? `- Organization: ${profile.organization}` : ''}
- Address: ${profile.address1}${profile.address2 ? `, ${profile.address2}` : ''}
- City: ${profile.city}
- State/Province: ${profile.stateProvince}
- Postal Code: ${profile.postalCode}
- Country: ${profile.country}
- Phone: ${profile.phone}
- Email: ${profile.email}`;
  }
  
  private formatContactInfoForApi(profile: RegistrantProfile): Record<string, string> {
    // In Namecheap API, we need to format contact info for different contact types
    const contactTypes = ['Registrant', 'Tech', 'Admin', 'AuxBilling'];
    const contactInfo: Record<string, string> = {};
    
    contactTypes.forEach(contactType => {
      // Add each contact field with the appropriate prefix
      contactInfo[`${contactType}FirstName`] = profile.firstName;
      contactInfo[`${contactType}LastName`] = profile.lastName;
      if (profile.organization) {
        contactInfo[`${contactType}OrganizationName`] = profile.organization;
      }
      contactInfo[`${contactType}Address1`] = profile.address1;
      if (profile.address2) {
        contactInfo[`${contactType}Address2`] = profile.address2;
      }
      contactInfo[`${contactType}City`] = profile.city;
      contactInfo[`${contactType}StateProvince`] = profile.stateProvince;
      contactInfo[`${contactType}PostalCode`] = profile.postalCode;
      contactInfo[`${contactType}Country`] = profile.country;
      contactInfo[`${contactType}Phone`] = profile.phone;
      contactInfo[`${contactType}EmailAddress`] = profile.email;
    });
    
    return contactInfo;
  }
  
  private async callNamecheapApi(command: string, params: Record<string, string> = {}): Promise<any> {
    const apiKey = process.env.NAMECHEAP_API_KEY;
    const username = process.env.NAMECHEAP_USERNAME;
    
    if (!apiKey || !username) {
      throw new Error('Namecheap API credentials not configured. Please set NAMECHEAP_API_KEY and NAMECHEAP_USERNAME environment variables.');
    }
    
    const apiUrl = process.env.NODE_ENV === 'production' 
      ? 'https://api.namecheap.com/xml.response'
      : 'https://api.sandbox.namecheap.com/xml.response';
    
    try {
      const requestParams = {
        ApiUser: username,
        ApiKey: apiKey,
        UserName: username,
        ClientIp: await detectPublicIp(),
        Command: command,
        ...params
      };
      
      const response = await axios.get(apiUrl, { params: requestParams });
      const parser = new xml2js.Parser({ explicitArray: command === 'namecheap.users.getPricing' });
      const result = await parser.parseStringPromise(response.data);
      
      // Check for API errors
      if (result.ApiResponse.$.Status === 'ERROR' && result.ApiResponse.Errors) {
        const errorMsg = typeof result.ApiResponse.Errors.Error === 'string' 
          ? result.ApiResponse.Errors.Error 
          : Array.isArray(result.ApiResponse.Errors.Error) 
            ? result.ApiResponse.Errors.Error[0] 
            : result.ApiResponse.Errors.Error._;
        
        if (errorMsg && (
            errorMsg.includes('IP not whitelisted') || 
            errorMsg.includes('Invalid IP'))) {
          resetIpCache();
          // Retry once with a fresh IP
          return this.callNamecheapApi(command, params);
        }
        throw new Error(`API Error: ${errorMsg}`);
      }
      
      return result.ApiResponse;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(`API request failed: ${error.message}`);
      }
      throw error;
    }
  }

  private formatErrorResponse(message: string): string {
    // Simply return the error message as text to avoid content type errors
    return message;
  }
}

export default RegisterDomainTool; 