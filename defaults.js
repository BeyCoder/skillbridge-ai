(function () {
  const defaultProfile = {
    personal: {
      firstName: "",
      lastName: "",
      fullName: "",
      preferredName: "",
      email: "",
      phone: "",
      streetAddress: "",
      city: "",
      state: "",
      stateFull: "",
      postalCode: "",
      country: "United States",
      linkedIn: "",
      github: "",
      website: ""
    },
    education: {
      school: "",
      schoolShort: "",
      degree: "",
      degreeFull: "",
      major: "",
      startDate: "",
      graduationDate: ""
    },
    eligibility: {
      workAuthorizedWithoutSponsorship: "",
      requiresSponsorship: "",
      enrolledInAsuClasses: "",
      federalWorkStudyEligible: "",
      adult18OrOlder: ""
    },
    voluntaryDisclosures: {
      hispanicOrLatino: "",
      ethnicity: "",
      gender: "",
      veteranStatus: "",
      acceptTerms: ""
    },
    selfIdentification: {
      disabilityStatus: ""
    },
    application: {
      todayDateFormat: "MM/DD/YYYY",
      shortBio:
        "",
      customAnswers: []
    }
  };

  function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function deepMerge(base, override) {
    const output = deepClone(base);

    for (const [key, value] of Object.entries(override || {})) {
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        output[key] &&
        typeof output[key] === "object" &&
        !Array.isArray(output[key])
      ) {
        output[key] = deepMerge(output[key], value);
      } else {
        output[key] = value;
      }
    }

    return output;
  }

  globalThis.ApplicationAutofillDefaults = {
    defaultProfile,
    deepClone,
    deepMerge
  };
})();
