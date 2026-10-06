const tripService = require("../services/trip.service");

function toBool(value) {
  return value === "true" || value === true;
}

async function createTripRequest(req, res, next) {
  try {
    const {
      departmentId,
      purpose,
      date,
      departureTime,
      serviceMode, // "WAIT" | "DROP_AND_PICKUP"
      returnTime, // required when serviceMode = WAIT
      pickupTime, // required when serviceMode = DROP_AND_PICKUP
      driverId,
      vehicleId,
      passengerNames, // JSON string, e.g. '["Juan Dela Cruz","Maria Santos"]'
      stops, // JSON string of { type, address, order, locationId?, travelMinutes? }
      certifyOfficialBusiness,
      certifyRecordCorrectness,
      manualUrgent,
      urgentReason,
    } = req.body;

    if (!departmentId || !purpose || !date || !departureTime || !driverId || !vehicleId) {
      return res.status(400).json({
        message:
          "departmentId, purpose, date, departureTime, driverId, and vehicleId are required",
      });
    }

    if (!serviceMode) {
      return res.status(400).json({
        message: "serviceMode is required (WAIT or DROP_AND_PICKUP)",
      });
    }

    let parsedPassengers = [];
    let parsedStops = [];
    try {
      parsedPassengers = passengerNames ? JSON.parse(passengerNames) : [];
      parsedStops = stops ? JSON.parse(stops) : [];
    } catch (e) {
      return res.status(400).json({ message: "passengerNames and stops must be valid JSON" });
    }

    const authorizationLetterFile = req.files?.authorizationLetter?.[0] || null;

    const trip = await tripService.createTripRequest({
      requesterId: req.user.sub,
      departmentId,
      purpose,
      date,
      departureTime,
      serviceMode,
      returnTime,
      pickupTime,
      driverId,
      vehicleId,
      passengerNames: parsedPassengers,
      stops: parsedStops,
      certifyOfficialBusiness: toBool(certifyOfficialBusiness),
      certifyRecordCorrectness: toBool(certifyRecordCorrectness),
      manualUrgent: toBool(manualUrgent),
      urgentReason,
      authorizationLetterFile,
    });

    res.status(201).json({ trip });
  } catch (err) {
    next(err);
  }
}

async function listMyTrips(req, res, next) {
  try {
    const trips = await tripService.listMyTrips(req.user.sub);
    res.json({ trips });
  } catch (err) {
    next(err);
  }
}

async function listDepartments(req, res, next) {
  try {
    const departments = await tripService.listDepartments();
    res.json({ departments });
  } catch (err) {
    next(err);
  }
}

// GET /api/trips/locations — active destinations for the request form
async function listLocations(req, res, next) {
  try {
    const locations = await tripService.listLocations();
    res.json({ locations });
  } catch (err) {
    next(err);
  }
}

// Optional query: serviceMode, departureTime, returnTime, pickupTime, travelMinutes.
// When given, drivers already booked for that time are hidden.
async function listAvailableDrivers(req, res, next) {
  try {
    const drivers = await tripService.listAvailableDrivers(req.query);
    res.json({ drivers });
  } catch (err) {
    next(err);
  }
}

async function listAvailableVehicles(req, res, next) {
  try {
    const vehicles = await tripService.listAvailableVehicles(req.query);
    res.json({ vehicles });
  } catch (err) {
    next(err);
  }
}


// GET /api/trips/:id — requester, assigned driver, admin or head driver
async function getTrip(req, res, next) {
  try {
    const trip = await tripService.getTripForUser(req.user, req.params.id);
    res.json({ trip });
  } catch (err) {
    next(err);
  }
}

async function getDriverDetail(req, res, next) {
  try {
    const driver = await tripService.getDriverDetail(req.params.driverId);
    res.json({ driver });
  } catch (err) {
    next(err);
  }
}

// POST /api/trips/:id/rating   body: { score, comment }
async function rateTrip(req, res, next) {
  try {
    const { score, comment } = req.body;
    const rating = await tripService.rateTrip(req.user.sub, req.params.id, { score, comment });
    res.status(201).json({ rating });
  } catch (err) {
    next(err);
  }
}


// POST /api/trips/:id/print — records the first print, returns the ticket data
async function printTrip(req, res, next) {
  try {
    const { trip, settings } = await tripService.markPrinted(req.user, req.params.id);
    res.json({
      trip,
      approver: {
        name: settings.approverName,
        title: settings.approverTitle,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function listDriverDirectory(req, res, next) {
  try {
    const drivers = await tripService.listDriverDirectory();
    res.json({ drivers });          // wrapped, to match /trips/departments
  } catch (err) {
    next(err);
  }
}

async function listVehicleDirectory(req, res, next) {
  try {
    const vehicles = await tripService.listVehicleDirectory();
    res.json({ vehicles });         // wrapped
  } catch (err) {
    next(err);
  }
}


module.exports = {
  createTripRequest,
  printTrip,
  getTrip,
  getDriverDetail,
  rateTrip,
  listMyTrips,
  listDepartments,
  listLocations,
  listAvailableDrivers,
  listAvailableVehicles,
  listDriverDirectory,
  listVehicleDirectory,
  
};