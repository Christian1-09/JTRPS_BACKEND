const driverService = require("../services/driver.service");

// GET /api/driver/profile
async function getProfile(req, res, next) {
  try {
    const profile = await driverService.getProfile(req.user.sub);
    res.json({ profile });
  } catch (err) {
    next(err);
  }
}

// GET /api/driver/trips?scope=active|history
async function listTrips(req, res, next) {
  try {
    const trips = await driverService.listTrips(req.user.sub, req.query.scope || "active");
    res.json({ trips });
  } catch (err) {
    next(err);
  }
}

// GET /api/driver/trips/:id
async function getTrip(req, res, next) {
  try {
    const trip = await driverService.getTrip(req.user.sub, req.params.id);
    res.json({ trip });
  } catch (err) {
    next(err);
  }
}

// POST /api/driver/trips/:id/accept
async function acceptTrip(req, res, next) {
  try {
    const trip = await driverService.acceptTrip(req.user.sub, req.params.id);
    res.json({ trip });
  } catch (err) {
    next(err);
  }
}

// POST /api/driver/trips/:id/decline   body: { reason }
async function declineTrip(req, res, next) {
  try {
    const trip = await driverService.declineTrip(req.user.sub, req.params.id, req.body.reason);
    res.json({ trip });
  } catch (err) {
    next(err);
  }
}

// POST /api/driver/trips/:id/depart
// body: { odometerStart, fuelBalanceInTank, fuelIssuedByOffice, fuelPurchasedDuring }
async function recordDeparture(req, res, next) {
  try {
    const trip = await driverService.recordDeparture(req.user.sub, req.params.id, req.body);
    res.json({ trip });
  } catch (err) {
    next(err);
  }
}

// POST /api/driver/trips/:id/return
// body: { odometerEnd, balanceInTankLiters, gearOilUsedLiters?, lubricatingOilUsedLiters?,
//         greaseIssuedLiters?, remarks? }
async function recordReturn(req, res, next) {
  try {
    const trip = await driverService.recordReturn(req.user.sub, req.params.id, req.body);
    res.json({ trip });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getProfile,
  listTrips,
  getTrip,
  acceptTrip,
  declineTrip,
  recordDeparture,
  recordReturn,
};