const authService = require("../services/auth.service");

async function register(req, res, next) {
  try {
    const { email, password, fullName, phone, role } = req.body;

    if (!email || !password || !fullName || !role) {
      return res.status(400).json({
        message: "email, password, fullName and role are required",
      });
    }

    const validRoles = ["ADMIN", "HEAD_DRIVER", "DRIVER", "INSTRUCTOR", "PASSENGER"];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ message: `role must be one of: ${validRoles.join(", ")}` });
    }

    const user = await authService.register({ email, password, fullName, phone, role });
    res.status(201).json({ user });
  } catch (err) {
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: "email and password are required" });
    }

    const result = await authService.login({ email, password });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function refresh(req, res, next) {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ message: "refreshToken is required" });
    }

    const result = await authService.refresh(refreshToken);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function logout(req, res, next) {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      await authService.logout(refreshToken);
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

module.exports = { register, login, refresh, logout };
